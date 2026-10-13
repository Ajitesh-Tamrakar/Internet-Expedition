"""The capture processing pipeline: source data -> context -> embeddings.

Orchestration for the background worker. Every new capture is enqueued
from the API (core.api.views.CaptureViewSet); a django-q2 worker
process (`manage.py run_worker`) runs `process_capture` for each one.
The manual /capture-context/ and /capture-embedding/ endpoints call the
same phase functions synchronously, so there is exactly one pipeline
code path for all of them.

Safety across processes and restarts:

* The queue is Postgres (django-q2's ORM broker), so it survives a
  worker restart, and two workers cannot claim the same task (an atomic
  compare-and-swap on the queue row).
* `process_capture` opens with an atomic claim on the capture's status,
  so a duplicate or redelivered task is a fast no-op instead of a
  double run (and a double spend of API calls).
* Every Gemini call paces against the shared database slot
  (core.api.gemini.reserve_pace_slot), so any number of worker
  processes share the project's single API quota.

The capture's `status` field is the client-facing state machine:

    queued? -> pending -> processing_context -> processing_embeddings
        -> ready
               (any step fails -> failed + error_note; retry via
                POST /captures/<id>/retry/)

`queued` sits before `pending` for captures whose user is over the
per-user in-flight cap (CAPTURE_INFLIGHT_LIMIT); the worker's startup
sweep promotes them as slots free up.
"""

import logging
from datetime import timedelta

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone
from django_q.tasks import async_task

from core.api.gemini import GeminiProvider, is_window_overflow
from core.embedding_builder import build_capture_embeddings
from core.models import Capture, CaptureContext

logger = logging.getLogger(__name__)

# Dotted path the worker resolves (via pydoc.locate) to run a capture.
PIPELINE_TASK = "core.pipeline.process_capture"


def _inflight_statuses() -> list[str]:
    """Statuses that count against a user's in-flight cap.

    `queued` deliberately does NOT count: it is waiting, not running.
    """
    s = Capture.Status
    return [s.PENDING, s.PROCESSING_CONTEXT, s.PROCESSING_EMBEDDINGS]


def _stale_cutoff():
    """How old must a capture be to count as abandoned (its worker died).

    Keep CAPTURE_STALE_MINUTES above the queue's redelivery window
    (Q_CLUSTER 'retry', in minutes) so live work is never mistaken for
    dead work.
    """
    return timezone.now() - timedelta(
        minutes=getattr(settings, "CAPTURE_STALE_MINUTES", 50)
    )


def build_unified_text(
    text_context, image_context, video_context, audio_context
) -> str:
    """Join the populated per-source contexts into one labeled document
    for the unified summary.

    Mirrors collect_units' skip-empty rule: a section only appears when
    its stripped content is non-empty, so a capture with no video/audio
    never mentions them. Returns "" when nothing is populated.
    """
    sections: list[str] = []

    text = (text_context or "").strip()
    if text:
        sections.append(f"[TEXT]\n{text}")

    for label, field in (
        ("IMAGE", image_context),
        ("VIDEO", video_context),
        ("AUDIO", audio_context),
    ):
        for item in field or []:
            item_text = (item.get("context") or "").strip()
            if not item_text:
                continue
            sections.append(f"[{label} {item.get('id') or 'unknown'}]\n{item_text}")

    return "\n\n".join(sections)


def extract_contexts(capture, provider=None) -> tuple:
    """Run the provider over every source of a Capture and return the
    generated (text, image, video, audio) context values plus the
    unified summary ("" when it fails or nothing populated).

    Shared by the background pipeline, and (via
    MultiModelContextExtraction) by the manual /capture-context/
    endpoint.
    """
    provider = provider or GeminiProvider()

    text_context = ""
    image_context = []
    video_context = []
    audio_context = []

    # -------------------------
    # TEXT
    # -------------------------

    if capture.text_sources:
        # Clients may send "text" as a single string or a list;
        # normalize to a list so we never iterate a string
        # character-by-character.
        sources = (
            [capture.text_sources]
            if isinstance(capture.text_sources, str)
            else capture.text_sources
        )
        for source in sources:
            result = provider.summarize_text(source)

            text_context += result

    # -------------------------
    # IMAGES
    # -------------------------
    if capture.image_sources:
        for source in capture.image_sources:
            result = provider.describe_image(source)

            image_context.append(
                {
                    "id": source.get("id"),
                    "context": result,
                }
            )

    # -------------------------
    # SCREENSHOT
    # -------------------------

    if capture.screenshot:
        # Gemini's upload needs a path, not the Django FieldFile object.
        result = provider.describe_image(capture.screenshot.path)

        image_context.append(
            {
                "id": str(capture.capture_id),
                "context": result,
            }
        )

    # -------------------------
    # VIDEOS
    # -------------------------

    if capture.video_sources:
        for source in capture.video_sources:
            result = provider.describe_video(source)

            video_context.append(
                {
                    "id": source.get("id"),
                    "context": result,
                }
            )

    # -------------------------
    # AUDIO
    # -------------------------

    if capture.audio_sources:
        for source in capture.audio_sources:
            result = provider.transcribe_audio(source)

            audio_context.append(
                {
                    "id": source.get("id"),
                    "context": result,
                }
            )

    # -------------------------
    # SUMMARY (unified)
    # -------------------------
    # Runs last: every per-source context above is already in hand, so
    # the summary always describes the fully populated capture. It is an
    # *optional* path - any failure (including the unified doc
    # outgrowing the model window) degrades to "" and the capture is
    # saved with summary_text=None. The doc size is logged so an
    # oversized capture is diagnosable.
    unified = build_unified_text(
        text_context, image_context, video_context, audio_context
    )

    summary = ""
    if unified:
        try:
            summary = provider.unified_context(unified)
        except Exception as err:
            detail = (
                " (looks like a context-window overflow)"
                if is_window_overflow(err)
                else ""
            )
            logger.warning(
                "Unified summary failed for capture %s: %d chars of "
                "unified text%s: %s",
                capture.capture_id,
                len(unified),
                detail,
                err,
            )

    return text_context, image_context, video_context, audio_context, summary


def build_capture_context(capture, provider=None) -> CaptureContext:
    """Context phase: extract from every source, then upsert the row.

    Creates the CaptureContext when absent, refreshes it when present -
    so a re-run never 500s on the OneToOne constraint, and a failed
    summary regeneration clears the stale summary instead of leaving a
    summary of the old content next to the new contexts.
    """
    text, image, video, audio, summary = extract_contexts(capture, provider)
    values = dict(
        text_context=text,
        image_context=image,
        video_context=video,
        audio_context=audio,
        summary_text=summary or None,
    )

    context = CaptureContext.objects.filter(capture_id=capture).first()
    if context is None:
        try:
            with transaction.atomic():
                return CaptureContext.objects.create(
                    user=capture.user, capture_id=capture, **values
                )
        except IntegrityError:
            # Lost a create race (e.g. the manual endpoint ran at the
            # same time); refresh the winner's row instead.
            context = CaptureContext.objects.get(capture_id=capture)

    for field, value in values.items():
        setattr(context, field, value)
    context.save()
    return context


def _set_status(capture, status_value, error_note=None) -> None:
    """Move the capture to `status_value` atomically.

    A queryset update (not save()) so concurrent processes agree on the
    same row state; updated_at is stamped explicitly because auto_now
    fields are NOT updated by queryset .update() - the recovery sweep
    relies on it to tell live work from abandoned work.
    """
    Capture.objects.filter(pk=capture.pk).update(
        status=status_value,
        error_note=error_note,
        updated_at=timezone.now(),
    )
    capture.status = status_value
    capture.error_note = error_note


def process_capture(capture_id) -> None:
    """Run the whole pipeline for one capture: context phase, then
    embedding phase. This is the function the worker executes.

    The status transitions are the source of truth the client polls and
    the recovery sweep trusts. On failure the capture is marked `failed`
    with a short error note, then the error is re-raised so the queue
    also records the failed task. There is no automatic retry - a broken
    capture would otherwise burn API budget on every redelivery; use
    POST /captures/<id>/retry/ to try again once the cause is fixed.
    """
    capture = Capture.objects.filter(pk=capture_id).first()
    if capture is None:
        # Deleted between enqueue and pickup; nothing to do.
        logger.warning("pipeline: capture %s no longer exists; skipping", capture_id)
        return

    s = Capture.Status

    # Atomic claim. Duplicate or redelivered tasks lose here and become
    # no-ops. In-flight states are only claimed when the capture looks
    # ABANDONED (updated_at old): a fresh in-flight capture belongs to a
    # live worker and must not be stolen, and a `ready`/`failed`
    # capture is done until explicitly retried.
    if capture.status in (s.PENDING, s.QUEUED):
        claimed = Capture.objects.filter(
            pk=capture.pk, status__in=[s.PENDING, s.QUEUED]
        ).update(
            status=s.PROCESSING_CONTEXT, error_note=None, updated_at=timezone.now()
        )
    elif capture.status in (s.PROCESSING_CONTEXT, s.PROCESSING_EMBEDDINGS):
        claimed = Capture.objects.filter(
            pk=capture.pk, status=capture.status, updated_at__lt=_stale_cutoff()
        ).update(
            status=s.PROCESSING_CONTEXT, error_note=None, updated_at=timezone.now()
        )
    else:
        logger.info(
            "pipeline: capture %s is %s; already complete, skipping",
            capture_id,
            capture.status,
        )
        return

    if not claimed:
        logger.info("pipeline: capture %s claimed by another run; skipping", capture_id)
        return

    capture.status = s.PROCESSING_CONTEXT
    capture.error_note = None
    # One paced provider for the whole run (pacing is per-call anyway).
    provider = GeminiProvider()

    try:
        build_capture_context(capture, provider)
        _set_status(capture, s.PROCESSING_EMBEDDINGS)
        context = CaptureContext.objects.get(capture_id=capture)
        build_capture_embeddings(context, provider)
        _set_status(capture, s.READY)
        logger.info("pipeline: capture %s complete (ready)", capture_id)
    except Exception as err:
        _set_status(
            capture, s.FAILED, error_note=f"{type(err).__name__}: {err}"[:500]
        )
        logger.exception("pipeline: capture %s failed", capture_id)
        raise


def enqueue_capture_processing(capture) -> bool:
    """Queue the capture for background processing.

    Returns True when a task was enqueued. When the user already has
    CAPTURE_INFLIGHT_LIMIT captures in flight, the capture waits in
    `queued` status instead and the worker's startup sweep promotes it
    once a slot frees up - so one user's bulk import cannot starve the
    shared (project-wide) API quota.
    """
    limit = getattr(settings, "CAPTURE_INFLIGHT_LIMIT", 2)

    if capture.user_id:
        in_flight = (
            Capture.objects.filter(
                user_id=capture.user_id, status__in=_inflight_statuses()
            )
            .exclude(pk=capture.pk)
            .count()
        )
    else:
        # Anonymous captures share no per-user budget.
        in_flight = 0

    if in_flight >= limit:
        _set_status(capture, Capture.Status.QUEUED)
        logger.info(
            "capture %s: %d of %d in-flight slots already used by its user; "
            "queued, the worker's sweep will promote it",
            capture.capture_id,
            in_flight,
            limit,
        )
        return False

    _set_status(capture, Capture.Status.PENDING)
    async_task(PIPELINE_TASK, str(capture.capture_id))
    return True


def _requeue(capture) -> None:
    """Put a capture back in the queue.

    Safe to over-call: a duplicate run hits the claim guard in
    process_capture and is a fast no-op (no API spend).
    """
    _set_status(capture, Capture.Status.PENDING)
    async_task(PIPELINE_TASK, str(capture.capture_id))


def sweep_stuck_captures() -> int:
    """Re-queue work a dead worker may have abandoned, and promote
    `queued` captures whose user now has a free slot.

    Runs at worker startup (`manage.py run_worker`). It is safe to be
    wrong in the "re-queue" direction - a duplicate run hits the claim
    guard and is a no-op - so it errs on the side of re-queueing.
    Returns the number of captures re-queued or promoted.
    """
    requeued = 0
    stale = _stale_cutoff()

    # 1. Abandoned mid-processing: its worker is gone (a live worker
    #    finishes or fails its capture long before `stale`).
    for capture in Capture.objects.filter(
        status__in=[
            Capture.Status.PROCESSING_CONTEXT,
            Capture.Status.PROCESSING_EMBEDDINGS,
        ],
        updated_at__lt=stale,
    ):
        logger.warning(
            "sweep: re-queueing abandoned capture %s (was %s)",
            capture.capture_id,
            capture.status,
        )
        _requeue(capture)
        requeued += 1

    # 2. Pending but stale: either a healthy deep backlog (its queue row
    #    is still there; the duplicate run will be a no-op) or a crash
    #    between the status save and the enqueue (the run recovers it).
    #    Either way, safe.
    for capture in Capture.objects.filter(
        status=Capture.Status.PENDING, updated_at__lt=stale
    ):
        _requeue(capture)
        requeued += 1

    # 3. Promote `queued` captures, FIFO per user, up to the cap.
    limit = getattr(settings, "CAPTURE_INFLIGHT_LIMIT", 2)
    user_ids = (
        Capture.objects.filter(status=Capture.Status.QUEUED)
        .exclude(user_id__isnull=True)
        .values_list("user_id", flat=True)
        .distinct()
    )
    for user_id in user_ids:
        in_flight = Capture.objects.filter(
            user_id=user_id, status__in=_inflight_statuses()
        ).count()
        slots = limit - in_flight
        if slots <= 0:
            continue
        for capture in Capture.objects.filter(
            user_id=user_id, status=Capture.Status.QUEUED
        ).order_by("created_at")[:slots]:
            logger.info(
                "sweep: promoting queued capture %s for user %s",
                capture.capture_id,
                user_id,
            )
            _requeue(capture)
            requeued += 1

    return requeued
