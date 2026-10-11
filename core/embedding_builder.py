"""Embedding pipeline for CaptureContext rows.

Plain functions only — no request/response/serializer objects — so the
exact same code runs from the API viewset, the management command, or
a future worker.

Stages:
  1. collect_units(context)  — flatten the context into ordered
                               (source_type, ref, text) units, skipping
                               empty ones
  2. embed                   — GeminiProvider.generate_embeddings per
                               unit (splits long texts, returns vectors)
  3. write                   — per source: delete stale rows,
                               bulk_create the fresh ones — all inside
                               one transaction (all-or-nothing)

The slow API calls happen *before* the transaction: if any embed call
fails, nothing is written and the previous rows survive intact, so a
failed build is safe to simply re-run.
"""

from django.db import transaction

from core.api.gemini import EMBED_MODEL, GeminiProvider
from core.models import CaptureEmbedding, CaptureContext

# gemini-embedding-2's default output dimension. The DB column is
# unconstrained `vector`, so this is enforced here at write time.
EXPECTED_DIMENSIONS = 3072


def collect_units(context: CaptureContext) -> list[tuple[str, str, str]]:
    """Flatten a CaptureContext into ordered (source_type, ref, text) units.

    The order is fixed — text, image, video, audio, summary — so the same
    context always yields the same rows. Units whose text is empty or
    whitespace-only are skipped: we never embed "".
    """
    t = CaptureEmbedding.SourceType
    units: list[tuple[str, str, str]] = []

    text = (context.text_context or "").strip()
    if text:
        units.append((t.TEXT, "context", text))

    for source_type, field in (
        (t.IMAGE, context.image_context),
        (t.VIDEO, context.video_context),
        (t.AUDIO, context.audio_context),
    ):
        for item in field or []:
            item_text = (item.get("context") or "").strip()
            if not item_text:
                continue
            units.append((source_type, str(item.get("id") or "unknown"), item_text))

    summary = (context.summary_text or "").strip()
    if summary:
        units.append((t.SUMMARY, "global", summary))

    return units


def build_capture_embeddings(
    context: CaptureContext,
    provider: GeminiProvider | None = None,
) -> dict:
    """(Re)build every CaptureEmbedding row for `context`'s capture.

    Idempotent: re-running replaces each source's rows (delete-then-
    create per source, one transaction), so chunk-count changes never
    leave stale rows. Returns a summary: {"sources": n, "rows": n}.
    Raises if any embed call fails — in that case nothing was written.
    """
    provider = provider or GeminiProvider()
    units = collect_units(context)

    # Stage 2 — embed everything first (slow API calls, no DB work).
    # Grouped by (source_type, ref); chunks are numbered continuously
    # per group so duplicate refs (same id listed twice) still get
    # unique source_keys.
    groups: dict[tuple[str, str], list[tuple[int, str, list[float]]]] = {}
    for source_type, ref, text in units:
        key = (source_type, ref)
        chunks = groups.setdefault(key, [])
        for chunk_text, vector in provider.generate_embeddings(text):
            if len(vector) != EXPECTED_DIMENSIONS:
                raise ValueError(
                    f"Expected a {EXPECTED_DIMENSIONS}-dim vector from "
                    f"{EMBED_MODEL}, got {len(vector)} (source={key})"
                )
            chunks.append((len(chunks), chunk_text, vector))

    if not groups:
        return {"sources": 0, "rows": 0}

    # Stage 3 — write: per source, delete the old rows then insert the
    # fresh ones. One transaction = all-or-nothing across the capture.
    with transaction.atomic():
        for (source_type, ref), chunks in groups.items():
            prefix = f"{source_type}:{ref}:"
            CaptureEmbedding.objects.filter(
                capture_id=context.capture_id,
                source_key__startswith=prefix,
            ).delete()
            CaptureEmbedding.objects.bulk_create(
                CaptureEmbedding(
                    user=context.user,
                    capture_id=context.capture_id,
                    source_key=f"{source_type}:{ref}:{idx}",
                    text=chunk_text,
                    embedding=vector,
                    embedding_model=EMBED_MODEL,
                )
                for idx, chunk_text, vector in chunks
            )

    return {
        "sources": len(groups),
        "rows": sum(len(chunks) for chunks in groups.values()),
    }
