from pgvector.django import VectorField
from django.conf import settings
from django.db import models
import uuid


# Create your models here.
class Bookmark(models.Model):

    class Platform(models.TextChoices):
        YOUTUBE = "youtube", "YouTube"
        LINKEDIN = "linkedin", "LinkedIn"
        PINTEREST = "pinterest", "Pinterest"
        TWITTER = "twitter", "Twitter/X"
        WEB = "web", "Web"

    class Processing_Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PROCESSING = "processing", "Processing"
        COMPLETE = "complete", "Complete"
        FAILED = "failed", "Failed"

    class CaptureMethod(models.TextChoices):
        PLATFORM_INJECTION = "platform_injection", "Platform Injection"
        TOOLBAR_POPUP = "toolbar_popup", "Toolbar Popup"
        CONTEXT_MENU = "context_menu", "Context Menu"

    class TranscriptSource(models.TextChoices):
        API = "api", "YouTube Transcript API"
        WHISPER = "whisper", "Whisper (local)"

    class Stages(models.TextChoices):
        EXTRACTION = "extraction"
        TAGGING = "tagging"
        CHUNKING = "chunking"
        EMBEDDING = "embedding"

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete = models.CASCADE, related_name = 'bookmarks', null = True, blank = True)
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    url = models.TextField(null=False)
    title = models.CharField(max_length=255, null=True, blank=True)
    platform = models.CharField(max_length=50, choices=Platform.choices)
    has_text = models.BooleanField(default=False)
    has_image = models.BooleanField(default=False)
    has_video = models.BooleanField(default=False)
    has_highlight = models.BooleanField(default=False)
    has_screenshot = models.BooleanField(default=False)
    processing_status = models.CharField(
        max_length=50,
        choices=Processing_Status.choices,
        default=Processing_Status.PENDING,
    )
    processing_error = models.TextField(null=True, blank=True)
    retry_count = models.IntegerField(default=0)
    failed_at = models.CharField(max_length=20, null=True, choices=Stages)
    current_step = models.CharField(
        max_length=20, null=True, blank=True, choices=Stages
    )
    processing_started_at = models.DateTimeField(null=True, blank=True)
    capture_method = models.CharField(
        max_length=50, choices=CaptureMethod.choices, null=True, blank=True
    )
    raw_text = models.JSONField(null=True, blank=True)
    author = models.CharField(max_length=100, null=True, blank=True)
    transcript_source = models.CharField(
        max_length=50, choices=TranscriptSource.choices, null=True, blank=True
    )
    saved_at = models.DateTimeField(auto_now_add=True)
    processed_at = models.DateTimeField(null=True, blank=True)
    platform_metadata = models.JSONField(null=True, blank=True)
    user_note = models.TextField(null=True, blank=True)

    class Meta:
        db_table = "bookmarks"


class Tag(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=50, null=False, blank=False, unique=True)

    class Meta:
        db_table = "tags"


class BookmarkTag(models.Model):
    class Source(models.TextChoices):
        AI = "ai", "AI Generated"
        MANUAL = "manual", "Manually Added"

    bookmark = models.ForeignKey(
        "Bookmark", on_delete=models.CASCADE, db_column="bookmark_id"
    )
    tag = models.ForeignKey("Tag", on_delete=models.CASCADE, db_column="tag_id")
    source = models.CharField(max_length=50, choices=Source.choices)

    class Meta:
        db_table = "bookmark_tags"
        constraints = [
            models.UniqueConstraint(fields=["bookmark", "tag"], name="bookmark_tag")
        ]


class Chunk(models.Model):
    class ChunkType(models.TextChoices):
        ARTICLE = "article", "Article"
        VIDEO = "video", "Video"
        AUDIO = "audio", "Audio"
        IMAGE = "image", "Image"
        POST = "post", "Post"
        HIGHLIGHT = "highlight", "Highlight"
        SCREENSHOT = "screenshot", "Screenshot"
        NOTE = "note", "Note"
        METADATA = "metadata", "Metadata"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    bookmark = models.ForeignKey(
        "Bookmark", on_delete=models.CASCADE, db_column="bookmark_id"
    )
    text = models.TextField(null=False)
    chunk_type = models.CharField(max_length=50, choices=ChunkType.choices)
    chunk_index = models.IntegerField(null=True, blank=True)
    embedding = VectorField(dimensions=None, null=True, blank=True)
    timestamp_seconds = models.IntegerField(
        null=True, blank=True
    )  # To Store youtube timestamps to jump to
    is_note = models.BooleanField(default=False)
    word_count = models.IntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "chunks"
        ordering = ["chunk_index"]


class Config(models.Model):

    class EmbeddingProvider(models.TextChoices):
        OLLAMA = "ollama", "Ollama"
        OPENAI = "openai", "OpenAI"
        GOOGLE = "google", "Google"

    class GenerationProvider(models.TextChoices):
        OLLAMA = "ollama", "Ollama"
        OPENAI = "openai", "OpenAI"
        ANTHROPIC = "anthropic", "Anthropic"
        GOOGLE = "google", "Google"

    class WhisperModel(models.TextChoices):
        TINY = "tiny", "Tiny"
        BASE = "base", "Base"
        SMALL = "small", "Small"
        MEDIUM = "medium", "Medium"
        LARGE = "large", "Large"

    id = models.IntegerField(primary_key=True, default=1)

    # Embedding -- locked after setup
    embedding_provider = models.CharField(
        max_length=50, choices=EmbeddingProvider.choices, null=True, blank=True
    )
    embedding_model_name = models.CharField(max_length=100, null=True, blank=True)
    embedding_dimensions = models.IntegerField(null=True, blank=True)
    embedding_locked = models.BooleanField(default=False)

    # Generation
    generation_provider = models.CharField(
        max_length=20, choices=GenerationProvider.choices, null=True, blank=True
    )
    generation_model_name = models.CharField(max_length=100, null=True, blank=True)

    # Whisper
    whisper_model_name = models.CharField(
        max_length=20, choices=WhisperModel.choices, null=True, blank=True
    )

    # System
    setup_complete = models.BooleanField(default=False)
    server_port = models.IntegerField(default=8080)
    dev_mode = models.BooleanField(default=False)

    def save(self, *args, **kwargs):
        self.id = 1
        super().save(*args, **kwargs)

    @classmethod
    def get(cls):
        return cls.objects.get(id=1)

    class Meta:
        db_table = "config"


class WorkerStatus(models.Model):

    class State(models.TextChoices):
        IDLE = "idle", "Idle"
        WORKING = "working", "Working"

    id = models.IntegerField(primary_key=True, default=1)
    state = models.CharField(max_length=20, choices=State.choices, default=State.IDLE)
    current_bookmark = models.ForeignKey(
        "Bookmark",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
    )
    updated_at = models.DateTimeField(auto_now=True)

    def save(self, *args, **kwargs):
        self.id = 1
        super().save(*args, **kwargs)

    class Meta:
        db_table = "worker_status"


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
