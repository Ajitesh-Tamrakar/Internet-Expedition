import base64
import re
import uuid
from datetime import datetime
from pathlib import Path

from django.core.files.base import ContentFile
from rest_framework import serializers

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
        capture_data = self.context["request"].data
        media = capture_data.get("media") or {}

        image_sources = []
        for image in media.get("images", []):
            if image.get("url"):
                id = str(uuid.uuid4())
                image_sources.append({"id": id, "url": image["url"]})

        video_sources = []
        for video in media.get("videos", []):
            if video.get("url"):
                id = str(uuid.uuid4())
                video_sources.append({"id": id, "url": video["url"]})

        audio_sources = []
        for audio in media.get("audios", []):
            if audio.get("url"):
                id = str(uuid.uuid4())
                audio_sources.append({"id": id, "url": audio["url"]})

        image = capture_data.get("image") or ""

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

            screenshot = ContentFile(
                image_bytes,
                name=f"capture_{datetime.now().strftime('%Y%m%d%H%M%S')}.{ext}",
            )

        # "text" may arrive as a single string or a list; store it as a list.
        text = capture_data.get("text") or []
        if isinstance(text, str):
            text = [text]

        return Capture.objects.create(
            user=validated_data["user"],
            image_sources=image_sources,
            video_sources=video_sources,
            audio_sources=audio_sources,
            screenshot=screenshot,
            text_sources=text,
        )

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
