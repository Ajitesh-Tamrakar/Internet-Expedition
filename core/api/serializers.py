from core.models import Capture, CaptureContext
from django.core.files.base import ContentFile
from rest_framework import serializers
from datetime import datetime
from pathlib import Path
import base64
import uuid
import re

class CaptureSerializer(serializers.ModelSerializer):
    class Meta:
        model = Capture
        fields = "__all__"
        read_only_fields = ["user"]

    def create(self, validated_data):
        capture_data = self.context["request"].data
        media = capture_data.get("media")

        image_sources = []
        for image in media.get("images", []):
            if image.get("url"):
                id = uuid.uuid4()
                image_sources.append({"id": id, "url": image["url"]})

        video_sources = []
        for video in media.get("videos", []):
            if video.get("url"):
                id = uuid.uuid4()
                video_sources.append({"id": id, "url": video["url"]})

        audio_sources = []
        for audio in media.get("audios", []):
            if audio.get("url"):
                id = uuid.uuid4()
                audio_sources.append({"id": id, "url": audio["url"]})

        image = capture_data.get("image", "")

        image_file = None

        if image:
            match = re.match(r"^data:image/(png|jpeg);base64,(.+)$", image)

            if not match:
                raise serializers.ValidationError("image: Invalid base64 format")
            ext = "jpg" if match.group(1) == "jpeg" else "png"
        try:
            image_bytes = base64.b64decode(match.group(2), validate=True)
        except Exception as e:
            raise serializers.ValidationError("image: Invalid base64 format")

        return Capture.objects.create(
            user=validated_data["user"],
            image_sources=image_sources,
            video_sources=video_sources,
            audio_sources=audio_sources,
            screenshot=ContentFile(
                image_bytes,
                name=f"capture_{datetime.now().strftime('%Y%m%d%H%M%S')}.{ext}",
            ),
            text_sources=capture_data.get("text", []),
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
            "created_at",
            "updated_at",
        ]

        read_only_fields = fields
