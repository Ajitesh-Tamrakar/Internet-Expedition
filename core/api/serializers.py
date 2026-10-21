import base64
import json
import re
import uuid
from pathlib import Path

from django.conf import settings
from django.core.files.base import ContentFile
from rest_framework import serializers

from core import storage as media_storage
from core.models import Capture, CaptureContext, CaptureEmbedding


class CaptureSerializer(serializers.ModelSerializer):
    class Meta:
        model = Capture
        fields = "__all__"
        # status/error_note are the background pipeline's, not the
        # client's: the client polls status, it never sets it (retry
        # goes through POST /captures/<id>/retry/).
        read_only_fields = ["user", "status", "error_note"]

    def create(self, validated_data):
        """Create the capture, and store its media in the storage backend.

        The payload is a superset of the historical JSON contract:

        * JSON (as before): ``media.images/videos/audios`` items are
          ``{"url": ...}`` — the client sends links, the worker's media
          ingest step later downloads them into the bucket.
        * multipart (extension that collected the files itself): the
          same ``media`` JSON object is sent as a form field, plus file
          parts named ``file:<kind>:<index>`` (index = the item's
          position in the ``media.<kind>`` list). An item with a paired
          file part is stored *now*, during this request, and its entry
          keeps the original URL as ``original_url``.

        Both forms may be mixed in one request, and every item shape
        the old client sends is accepted unchanged.
        """
        request = self.context["request"]
        data = request.data
        files = getattr(request, "FILES", None) or {}

        media = data.get("media") or {}
        if isinstance(media, str):
            # multipart: the JSON object arrives as a plain form field.
            try:
                media = json.loads(media)
            except ValueError:
                raise serializers.ValidationError(
                    {"media": "Must be a JSON object."}
                )

        # "text" may arrive as a single string or a list; store it as a
        # list. (In multipart the extension may send the JSON list as
        # one field; parse it when it clearly is one.)
        text = data.get("text") or []
        if isinstance(text, str):
            stripped = text.strip()
            if stripped.startswith("["):
                try:
                    parsed = json.loads(stripped)
                    if isinstance(parsed, list):
                        text = parsed
                except ValueError:
                    pass
            if isinstance(text, str):
                text = [text]

        max_file = getattr(settings, "MEDIA_MAX_FILE_BYTES", 50 * 1024 * 1024)
        max_total = getattr(
            settings, "MEDIA_MAX_TOTAL_PER_CAPTURE", 200 * 1024 * 1024
        )

        def _attached(kind: str) -> dict[int, object]:
            """File parts for one kind, keyed by their index in the
            media JSON list (part name: ``file:<kind>:<index>``)."""
            if not files:
                return {}
            pattern = re.compile(rf"^file:{kind}:(\d+)$")
            attached = {}
            for name in files.keys():
                match = pattern.match(name)
                if match:
                    attached[int(match.group(1))] = files.get(name)
            return attached

        # Size gates, checked before anything is stored: a rejection
        # here means no capture row and no orphaned objects.
        total_size = 0
        for kind in ("images", "videos", "audios"):
            for index, file in _attached(kind).items():
                if file.size > max_file:
                    raise serializers.ValidationError(
                        {
                            f"file:{kind}:{index}": (
                                f"exceeds the {max_file} byte per-file limit"
                            )
                        }
                    )
                total_size += file.size
        if total_size > max_total:
            raise serializers.ValidationError(
                {
                    "detail": (
                        f"media exceeds the {max_total} byte per-capture limit"
                    )
                }
            )

        # Build the instance first: its UUID (the storage prefix) exists
        # from construction, so attached files can be uploaded before the
        # row is inserted — a failed upload then leaves no row behind.
        capture = Capture(user=validated_data["user"], text_sources=text)
        capture_id = str(capture.capture_id)

        def _stored_name(kind: str, source_id: str, ext: str) -> str:
            return media_storage.media_object_path(capture_id, kind, source_id, ext)

        def _build_sources(kind: str) -> list[dict]:
            sources = []
            for index, item in enumerate(media.get(kind) or []):
                if not isinstance(item, dict):
                    continue
                url = (item.get("url") or "").strip()
                file = _attached(kind).get(index)
                if file is None and not url:
                    continue  # empty item: skip, as before
                source_id = item.get("id") or str(uuid.uuid4())
                if file is not None:
                    # The client collected the file: store it now, in the
                    # web process, and point the entry at the stored
                    # object. The worker's ingest step will skip it.
                    name = _stored_name(
                        kind,
                        source_id,
                        media_storage.extension_for(file.name, file.content_type),
                    )
                    media_storage.save_bytes(name, file.read())
                    sources.append(
                        {"id": source_id, "url": name, "original_url": url or None}
                    )
                else:
                    # Link-only item: as before. No original_url yet —
                    # that key marks "ingest has assessed this", so it
                    # stays unset for the worker to fill in.
                    sources.append({"id": source_id, "url": url})
            return sources

        image_sources = _build_sources("images")
        video_sources = _build_sources("videos")
        audio_sources = _build_sources("audios")

        image = data.get("image") or ""
        screenshot = None
        if image:
            match = re.match(r"^data:image/(png|jpeg);base64,(.+)$", image)

            if not match:
                raise serializers.ValidationError("image: Invalid base64 format")
            ext = "jpg" if match.group(1) == "jpeg" else "png"

            try:
                image_bytes = base64.b64decode(match.group(2), validate=True)
            except Exception:
                raise serializers.ValidationError("image: Invalid base64 format")

            # The web process has the bytes in hand: the screenshot
            # uploads to the storage backend during this request (the
            # ImageField routes through the default backend — Supabase
            # when configured, local disk otherwise).
            screenshot = ContentFile(image_bytes, name=f"screenshot.{ext}")

        capture.image_sources = image_sources
        capture.video_sources = video_sources
        capture.audio_sources = audio_sources
        capture.screenshot = screenshot

        try:
            capture.save()
        except Exception as err:
            # Nothing durable may survive a failed create: remove whatever
            # landed in the bucket/local disk (everything is under the
            # capture's prefix), and report a clean 400.
            media_storage.cleanup_capture_media(capture_id)
            raise serializers.ValidationError(
                {"detail": f"Failed to store capture media: {err}"}
            ) from err

        return capture

    def to_representation(self, instance):
        response = super().to_representation(instance)

        if "image_sources" in response:
            del response["image_sources"]
        if "video_sources" in response:
            del response["video_sources"]
        if "audio_sources" in response:
            del response["audio_sources"]
        if "text_sources" in response:
            del response["text_sources"]

        response["capture"] = "success"
        return response

    def to_representation(self, instance):
        response = super().to_representation(instance)

        if "image_sources" in response:
            del response["image_sources"]
        if "video_sources" in response:
            del response["video_sources"]
        if "audio_sources" in response:
            del response["audio_sources"]
        if "text_sources" in response:
            del response["text_sources"]

        response["capture"] = "success"
        return response


class CaptureContextSerializer(serializers.ModelSerializer):
    class Meta:
        model = CaptureContext

        fields = [
            "capture_context_id",
            "capture_id",
            "user",
            "text_context",
            "image_context",
            "video_context",
            "audio_context",
            "summary_text",
            "created_at",
            "updated_at",
        ]

        read_only_fields = fields


class ChunkSerializer(serializers.Serializer):
    """One embedding row of a search result: what matched, and how well.

    `text` is a preview (truncated by the search helper); the full
    chunk text is retrievable from GET /capture-embedding/.
    """

    source_key = serializers.CharField()
    score = serializers.FloatField()
    text = serializers.CharField()


class SearchResultSerializer(serializers.Serializer):
    """A search hit: one capture, ranked, carrying all of its chunks
    (best-first). `score` is the capture's best-chunk cosine similarity
    (higher = more relevant; not a percentage)."""

    capture_id = serializers.UUIDField()
    rank = serializers.IntegerField()
    score = serializers.FloatField()
    summary_text = serializers.CharField(allow_null=True)
    created_at = serializers.DateTimeField(allow_null=True)
    chunks = ChunkSerializer(many=True)


class CaptureEmbeddingSerializer(serializers.ModelSerializer):
    # Metadata only — the vector (1536 floats ≈ 12KB of JSON) is for
    # Postgres, never for the client.

    class Meta:
        model = CaptureEmbedding

        fields = [
            "id",
            "source_key",
            "text",
            "embedding_model",
            "created_at",
        ]

        read_only_fields = fields
