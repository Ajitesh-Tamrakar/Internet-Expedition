from pgvector.django import VectorField
from django.conf import settings
from django.db import models
import uuid


# Create your models here.

class Capture(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete = models.CASCADE, related_name = 'captures', null = True, blank = True)
    capture_id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    screenshot = models.ImageField(upload_to='media/', null=True, blank=True)
    image_sources = models.JSONField(null=True, blank=True, default=list)
    video_sources = models.JSONField(null=True, blank=True, default=list)
    audio_sources = models.JSONField(null=True, blank=True, default=list)
    text_sources = models.JSONField(null=True, blank=True, default=list)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)



class CaptureContext(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete = models.CASCADE, related_name = 'capture_context', null = True, blank = True)
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
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='capture_embeddings', null=True, blank=True)
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
