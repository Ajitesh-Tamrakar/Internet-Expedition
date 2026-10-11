import uuid

from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.viewsets import ModelViewSet

from core.api.gemini import GeminiProvider
from core.api.serializers import (
    CaptureContextSerializer,
    CaptureEmbeddingSerializer,
    CaptureSerializer,
)
from core.embedding_builder import build_capture_embeddings
from core.models import Capture, CaptureContext, CaptureEmbedding


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

    # Detail routes are keyed by the context's own id:
    #   GET/PATCH/DELETE /capture-context/<capture_context_id>/
    # For POST the same URL slot carries the Capture id instead —
    # create() reads it and interprets it accordingly.
    lookup_field = "capture_context_id"

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
            # A malformed UUID in the URL should 404, not 500.
            try:
                uuid.UUID(capture_context_id)
            except ValueError:
                return None, Response(
                    {"detail": ("CaptureContext not found.")},
                    status=status.HTTP_404_NOT_FOUND,
                )

            context_from_url = get_object_or_404(
                CaptureContext,
                capture_context_id=capture_context_id,
                user=self.request.user,
            )

        # Find using capture_id
        if capture_id:
            # A malformed UUID should 404, not 500.
            try:
                uuid.UUID(capture_id)
            except ValueError:
                return None, Response(
                    {"detail": ("Capture not found.")},
                    status=status.HTTP_404_NOT_FOUND,
                )

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

    def list(self, request, *args, **kwargs):

        capture_id = request.query_params.get("capture_id")

        # GET /capture-context/?capture_id=<id> resolves to the single
        # context for that capture.
        if capture_id is not None:
            context, error = self.get_context()

            if error:
                return error

            serializer = self.get_serializer(context)

            return Response(serializer.data)

        # Plain GET /capture-context/ → paginated list of the
        # user's contexts (standard ModelViewSet behavior).
        return super().list(request, *args, **kwargs)

    def retrieve(self, request, *args, **kwargs):

        context, error = self.get_context()

        if error:
            return error

        serializer = self.get_serializer(context)

        return Response(serializer.data)

    def _extract_contexts(self, capture):
        """Run the provider over every source of a Capture and return
        the generated (text, image, video, audio) context values.
        Shared by create() and partial_update()."""

        provider = GeminiProvider()

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

        return text_context, image_context, video_context, audio_context

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
        # (The router names this slot "capture_context_id" via
        # lookup_field; create() reinterprets it as capture_id.)
        capture_id = self.kwargs.get("capture_context_id")

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

        (
            text_context,
            image_context,
            video_context,
            audio_context,
        ) = self._extract_contexts(capture)

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
                {"detail": ("A CaptureContext already exists for this Capture.")},
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

        # All context fields are read-only, so the client cannot supply
        # values — PATCH means "reprocess this Capture and refresh the
        # stored context".
        (
            text_context,
            image_context,
            video_context,
            audio_context,
        ) = self._extract_contexts(context.capture_id)

        context.text_context = text_context
        context.image_context = image_context
        context.video_context = video_context
        context.audio_context = audio_context

        context.save()

        serializer = self.get_serializer(context)

        return Response(serializer.data)

    def destroy(self, request, *args, **kwargs):

        context, error = self.get_context()

        if error:
            return error

        context.delete()

        return Response(status=status.HTTP_204_NO_CONTENT)


class CaptureEmbeddingViewSet(ModelViewSet):
    """Builds the embedding rows for a Capture's context.

    Contract (mirrors MultiModelContextExtraction):
      POST /capture-embedding/<capture_id>/
          The URL slot carries the **Capture** id, the request body is
          ignored. (Re)builds that capture's embedding rows from its
          stored context.
      GET  /capture-embedding/?capture_id=<id>
          The capture's embedding rows (metadata only, never vectors).

    The heavy lifting lives in core.embedding_builder.build_capture_
    embeddings — plain functions, no DRF — so the same code also runs
    from the `build_capture_embeddings` management command.
    """

    serializer_class = CaptureEmbeddingSerializer
    permission_classes = [IsAuthenticated]

    http_method_names = ["get", "post"]

    # Detail routes are keyed by the embedding row's own id (GET). For
    # POST the same URL slot carries the Capture id instead — create()
    # reads it and interprets it accordingly.
    lookup_field = "id"

    def get_queryset(self):
        return CaptureEmbedding.objects.filter(user=self.request.user)

    def get_capture(self):
        """Resolve the id (URL slot for POST, ?capture_id= for GET) as
        the requesting user's Capture. Malformed UUID → 404, not owned
        → 404 (never leak existence). Returns (capture, error_response).
        """
        capture_id = (
            self.kwargs.get("id")
            or self.request.query_params.get("capture_id")
        )

        if not capture_id:
            return None, Response(
                {
                    "detail": (
                        "Provide a capture_id (in the URL for POST, "
                        "or as ?capture_id= for GET)."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # A malformed UUID in the URL should 404, not 500.
        try:
            capture_id = uuid.UUID(capture_id)
        except ValueError:
            return None, Response(
                {"detail": ("Capture not found.")},
                status=status.HTTP_404_NOT_FOUND,
            )

        capture = get_object_or_404(
            Capture,
            capture_id=capture_id,
            user=self.request.user,
        )

        return capture, None

    def list(self, request, *args, **kwargs):
        # Plain GET → all the user's embedding rows (standard behavior).
        if request.query_params.get("capture_id") is None:
            return super().list(request, *args, **kwargs)

        # GET ?capture_id= → the single capture's rows.
        capture, error = self.get_capture()

        if error:
            return error

        rows = (
            self.get_queryset()
            .filter(capture_id=capture)
            .order_by("source_key")
        )

        return Response(self.get_serializer(rows, many=True).data)

    def create(self, request, *args, **kwargs):
        # Per the API contract, the capture id goes in the URL — the
        # ?capture_id= query form is NOT allowed on POST.
        if request.query_params.get("capture_id") is not None:
            return Response(
                {
                    "detail": (
                        "POST /capture-embedding/<capture_id>/ takes the "
                        "capture id in the URL, not as ?capture_id="
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        capture, error = self.get_capture()

        if error:
            return error

        # Embeddings are derived from the context: it must exist first.
        context = CaptureContext.objects.filter(
            capture_id=capture,
            user=request.user,
        ).first()

        if context is None:
            return Response(
                {
                    "detail": (
                        "No CaptureContext for this capture — run "
                        "POST /capture-context/<capture_id>/ first."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        result = build_capture_embeddings(context)

        rows = (
            self.get_queryset()
            .filter(capture_id=capture)
            .order_by("source_key")
        )

        return Response(
            {
                **result,
                "embeddings": self.get_serializer(rows, many=True).data,
            },
            status=status.HTTP_201_CREATED,
        )
