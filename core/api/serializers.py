import base64
from pathlib import Path
from django.http import response
from rest_framework import serializers
from core.models import Capture
import re
from datetime import datetime
from django.core.files.base import ContentFile

class CaptureSerializer(serializers.ModelSerializer):
    class Meta:
        model = Capture
        fields = '__all__'
        read_only_fields = ["user"]

    def create(self, validated_data):
        capture_data = self.context['request'].data
        media = capture_data.get('media')

        image_sources = []
        for image in media.get('images', []):
            if image.get('url'):
                image_sources.append(image['url'])

        video_sources = []
        for video in media.get('videos', []):
            if video.get('url'):
                video_sources.append(video['url'])

        audio_sources = []
        for audio in media.get('audios', []):
            if audio.get('url'):
                audio_sources.append(audio['url'])


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
            user = validated_data['user'],
            image_sources=image_sources,
            video_sources=video_sources,
            audio_sources=audio_sources,
            screenshot=ContentFile(image_bytes, name=f"capture_{datetime.now().strftime('%Y%m%d%H%M%S')}.{ext}"),
            text_sources=capture_data.get('text',[])
        )


    def to_representation(self, instance):
        response = super().to_representation(instance)

        if 'image_sources' in response:
            del response['image_sources']
        if 'video_sources' in response:
            del response['video_sources']
        if 'audio_sources' in response:
            del response['audio_sources']
        if 'text_sources' in response:
            del response['text_sources']

        response['capture'] = 'success'
        return response
        

