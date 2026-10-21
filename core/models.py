from datetime import datetime

import logging

from pgvector.django import VectorField
from django.conf import settings
from django.db import models
from django.utils import timezone
import uuid

from core.storage import screenshot_upload_to

logger = logging.getLogger(__name__)


# Create your models here.

class Capture(models.Model):
    class Status(models.TextChoices):
        # The client-facing state machine for the background pipeline:
        #   (queued) -> pending -> processing_media -> processing_context ->
        #   processing_embeddings -> ready | failed
        # `queued` sits before `pending` for captures whose user is over
        # the per-user in-flight cap (see CAPTURE_INFLIGHT_LIMIT); the
        # worker's startup sweep promotes them as slots free up.
        QUEUED = "queued", "Queued"
        PENDING = "pending", "Pending"
        PROCESSING_MEDIA = "processing_media", "Processing media"
        PROCESSING_CONTEXT = "processing_context", "Processing context"
        PROCESSING_EMBEDDINGS = "processing_embeddings", "Processing embeddings"
        READY = "ready", "Ready"
        FAILED = "failed", "Failed"

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete = models.CASCADE, related_name = 'captures')
    capture_id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # Every media file of a capture lives under its <capture_id>/ prefix in
    # the storage backend (core.storage): Supabase Storage when configured,
    # local disk otherwise (core.storage.screenshot_upload_to).
    screenshot = models.ImageField(upload_to=screenshot_upload_to, null=True, blank=True)
    image_sources = models.JSONField(null=True, blank=True, default=list)
    video_sources = models.JSONField(null=True, blank=True, default=list)
    audio_sources = models.JSONField(null=True, blank=True, default=list)
    text_sources = models.JSONField(null=True, blank=True, default=list)
    # Where the background pipeline is with this capture (see Status).
    # Clients poll this; the recovery sweep trusts it.
    status = models.CharField(max_length=32, choices=Status.choices, default=Status.PENDING)
    # One-line description of why a `failed` capture failed.
    error_note = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        # The recovery sweep scans (status, updated_at) at startup.
        indexes = [
            models.Index(fields=["status", "updated_at"])
        ]

    def delete(self, using=None, keep_parents=False):
        """Delete the row, then best-effort remove the capture's stored
        media (the whole <capture_id>/ prefix, plus a legacy screenshot
        file if it predates the per-capture layout).

        Storage problems never block or fail the database delete — they
        are logged. (QuerySet.delete() bulk paths bypass this hook; the
        single-object ORM delete is what the app, admin, and eval tooling
        use.)
        """
        # Both values must be read BEFORE super().delete(): Django's
        # Collector wipes the pk (and the delete invalidates the row) on
        # the instance, so anything read after would be gone.
        capture_id = self.capture_id
        legacy_screenshot_name = self.screenshot.name if self.screenshot else None
        deleted = super().delete(using=using, keep_parents=keep_parents)
        # Django 5.2: delete() returns (count, {label: count}); unpack the
        # count (a plain dict on older versions would break this unpack).
        deleted_count = (
            deleted[0] if isinstance(deleted, tuple) else sum(deleted.values())
        )
        if deleted_count:
            try:
                from core import storage as media_storage

                media_storage.cleanup_capture_media(
                    capture_id, legacy_screenshot_name=legacy_screenshot_name
                )
            except Exception:
                logger.warning(
                    "media cleanup failed for capture %s",
                    capture_id,
                    exc_info=True,
                )
        return deleted



class CaptureContext(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete = models.CASCADE, related_name = 'capture_context')
    capture_id = models.OneToOneField(Capture, on_delete=models.CASCADE, related_name='capture_context')
    capture_context_id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    text_context = models.TextField()
    image_context = models.JSONField(null=True, blank=True, default=list)
    video_context = models.JSONField(null=True, blank=True, default=list)
    audio_context = models.JSONField(null=True, blank=True, default=list)
    summary_text = models.TextField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "capture_context"


class CaptureEmbedding(models.Model):
    class SourceType(models.TextChoices):
        TEXT = "text", "Text"
        IMAGE = "image", "Image"
        VIDEO = "video", "Video"
        AUDIO = "audio", "Audio"
        SUMMARY = "summary", "Summary"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='capture_embeddings')
    capture_id = models.ForeignKey(Capture, on_delete=models.CASCADE, related_name='embeddings')
    # "source_type:source_id:chunk_index", e.g. "image:abc123:0", "text:context:1", "summary:global:0"
    source_key = models.CharField(max_length=255)
    # Exact text that was embedded (provenance; allows re-embedding after edits/model swaps)
    text = models.TextField()
    embedding = VectorField(dimensions=None, null=True, blank=True)
    embedding_model = models.CharField(max_length=100, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "capture_embeddings"
        constraints = [
            models.UniqueConstraint(fields=["capture_id", "source_key"], name="uniq_capture_source_key")
        ]
        indexes = [
            models.Index(fields=["user"])
        ]


def _epoch():
    return timezone.make_aware(datetime(1970, 1, 1))


class ProviderRateSlot(models.Model):
    """Shared "last API call" clock for provider rate limiting.

    One row per provider key. The clock lives in the *database*, not in
    process memory: the Gemini quota is per project (all users, all
    processes), so every web and worker process must reserve a slot
    against this same row before calling the API - see
    core.api.gemini.reserve_pace_slot. With an in-memory clock, two
    processes would each pace at full speed and double the quota.
    """
    key = models.CharField(max_length=50, primary_key=True)
    last_call_at = models.DateTimeField(default=_epoch, editable=False)


class OneTimeToken(models.Model):
    """A single-use, expiring code for passwordless login/signup.

    The code itself is never stored - only a salted SHA-256 hash
    (see core.otp), so a database leak does not expose live codes.
    """

    class Channel(models.TextChoices):
        EMAIL = "email", "Email"
        # SMS = "sms", "SMS"   # Phase 2: add a provider + channel.

    class Purpose(models.TextChoices):
        LOGIN = "login", "Login"
        SIGNUP = "signup", "Signup / email verification"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="one_time_tokens",
    )
    channel = models.CharField(
        max_length=20, choices=Channel.choices, default=Channel.EMAIL
    )
    purpose = models.CharField(
        max_length=20, choices=Purpose.choices, default=Purpose.LOGIN
    )
    salt = models.CharField(max_length=64)
    code_hash = models.CharField(max_length=128)
    expires_at = models.DateTimeField()
    attempts = models.PositiveSmallIntegerField(default=0)
    consumed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "one_time_tokens"
        indexes = [
            models.Index(
                fields=["user", "channel", "consumed_at", "-created_at"]
            )
        ]

    @property
    def is_valid(self) -> bool:
        return self.consumed_at is None and self.expires_at > timezone.now()

    def invalidate(self) -> None:
        self.consumed_at = timezone.now()
        self.save(update_fields=["consumed_at"])
