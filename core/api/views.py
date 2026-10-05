import uuid

from core.api.gemini import GeminiProvider
from rest_framework.permissions import IsAuthenticated
from rest_framework.viewsets import ModelViewSet
from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404
from rest_framework import status
from core.api.serializers import CaptureContextSerializer, CaptureSerializer
from core.models import Capture, CaptureContext
from rest_framework.response import Response


class CaptureViewSet(ModelViewSet):
    http_method_names = ["get", "post"]
    permission_classes = [IsAuthenticated]
    serializer_class = CaptureSerializer

    def get_queryset(self):
        return Capture.objects.filter(user=self.request.user)

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)






class MultiModelContextExtraction(ModelViewSet):
    serializer_class = CaptureContextSerializer
    permission_classes = [IsAuthenticated]

    http_method_names = ["get", "post", "patch", "delete"]

    def get_queryset(self):
        return CaptureContext.objects.filter(user=self.request.user)

    def get_context(self):

        capture_context_id = self.kwargs.get("capture_context_id")

        capture_id = self.request.query_params.get("capture_id")

        # Neither ID supplied
        if not capture_context_id and not capture_id:
            return None, Response(
                {"detail": ("Provide either capture_context_id or capture_id.")},
                status=status.HTTP_400_BAD_REQUEST,
            )

        context_from_url = None
        context_from_capture = None

        # Find using capture_context_id
        if capture_context_id:
            context_from_url = get_object_or_404(
                CaptureContext,
                capture_context_id=capture_context_id,
                user=self.request.user,
            )

        # Find using capture_id
        if capture_id:
            capture = get_object_or_404(
                Capture,
                capture_id=capture_id,
                user=self.request.user,
            )

            context_from_capture = get_object_or_404(
                CaptureContext,
                capture_id=capture,
                user=self.request.user,
            )

        # Both supplied → verify they refer
        # to the same CaptureContext
        if context_from_url and context_from_capture:
            if (
                context_from_url.capture_context_id
                != context_from_capture.capture_context_id
            ):
                return None, Response(
                    {
                        "detail": (
                            "capture_id and "
                            "capture_context_id do not "
                            "refer to the same CaptureContext."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

        context = context_from_url or context_from_capture

        return context, None

    def retrieve(self, request, *args, **kwargs):

        context, error = self.get_context()

        if error:
            return error

        serializer = self.get_serializer(context)

        return Response(serializer.data)

    def create(self, request, *args, **kwargs):

        # Per the API contract, POST means "process this Capture":
        #   POST /capture-context/<capture_id>/
        # The capture id comes from the URL — the ?capture_id= query
        # param form is NOT allowed, and the request body is ignored
        # (all context fields are read-only, the backend generates them).
        if request.query_params.get("capture_id") is not None:
            return Response(
                {
                    "detail": (
                        "POST /capture-context/<capture_id>/ takes the "
                        "capture id in the URL, not as ?capture_id="
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # The value in the URL slot is the **Capture** id for POST.
        # (The router currently names this slot "pk"; it will be renamed
        # to "capture_context_id" when the GET/PATCH/DELETE lookup is fixed.)
        capture_id = self.kwargs.get("pk")

        if not capture_id:
            return Response(
                {
                    "detail": (
                        "capture_id is required in the URL: "
                        "POST /capture-context/<capture_id>/"
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # A malformed id in the URL should 404, not 500.
        try:
            capture_id = uuid.UUID(capture_id)
        except ValueError:
            return Response(
                {"detail": ("Capture not found.")},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Make sure Capture belongs to user
        capture = get_object_or_404(
            Capture,
            capture_id=capture_id,
            user=request.user,
        )

        # Because CaptureContext is OneToOne,
        # check if it already exists.
        existing_context = CaptureContext.objects.filter(
            capture_id=capture,
            user=request.user,
        ).first()

        if existing_context:
            return Response(
                {"detail": ("CaptureContext already exists for this Capture.")},
                status=status.HTTP_400_BAD_REQUEST,
            )

        provider = GeminiProvider()

        text_context = ""
        image_context = []
        video_context = []
        audio_context = []

        # -------------------------
        # TEXT
        # -------------------------

        if capture.text_sources:
            for source in capture.text_sources:
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
            result = provider.describe_image(capture.screenshot)

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
        # SAVE
        # -------------------------

        # The OneToOne constraint is the source of truth: if two requests
        # race past the "already exists" check above, the second insert
        # fails here instead of creating a duplicate context.
        try:
            with transaction.atomic():
                context = CaptureContext.objects.create(
                    user=request.user,
                    capture_id=capture,
                    text_context=text_context,
                    image_context=image_context,
                    video_context=video_context,
                    audio_context=audio_context,
                )
        except IntegrityError:
            return Response(
                {
                    "detail": (
                        "A CaptureContext already exists for this Capture."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        serializer = self.get_serializer(context)

        return Response(
            serializer.data,
            status=status.HTTP_201_CREATED,
        )

    def partial_update(self, request, *args, **kwargs):

        context, error = self.get_context()

        if error:
            return error

        serializer = self.get_serializer(
            context,
            data=request.data,
            partial=True,
        )

        serializer.is_valid(raise_exception=True)

        serializer.save()

        return Response(serializer.data)

    def destroy(self, request, *args, **kwargs):

        context, error = self.get_context()

        if error:
            return error

        context.delete()

        return Response(status=status.HTTP_204_NO_CONTENT)
