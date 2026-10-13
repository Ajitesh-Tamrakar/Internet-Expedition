import logging
import math
import uuid

from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.viewsets import GenericViewSet, ModelViewSet

from core import pipeline
from core.api.serializers import (
    CaptureContextSerializer,
    CaptureEmbeddingSerializer,
    CaptureSerializer,
    SearchResultSerializer,
)
from core.embedding_builder import build_capture_embeddings
from core.models import Capture, CaptureContext, CaptureEmbedding
from core.search import search_captures

logger = logging.getLogger(__name__)


class CaptureViewSet(ModelViewSet):
    http_method_names = ["get", "post"]
    permission_classes = [IsAuthenticated]
    serializer_class = CaptureSerializer

    def get_queryset(self):
        return Capture.objects.filter(user=self.request.user)

    def perform_create(self, serializer):
        capture = serializer.save(user=self.request.user)

        # The capture is saved; from here the server does the work. The
        # background pipeline (core.pipeline) takes it from here:
        # context -> embeddings, with progress visible on `status` (the
        # client polls GET /captures/<id>/ instead of driving the
        # per-stage endpoints by hand). If enqueueing fails (broker
        # hiccup), the capture is still saved and the worker's startup
        # sweep will pick it up.
        try:
            pipeline.enqueue_capture_processing(capture)
        except Exception:
            logger.exception(
                "Failed to enqueue capture %s for background processing; "
                "it will be picked up by the worker's startup sweep.",
                capture.capture_id,
            )

    @action(detail=True, methods=["post"])
    def retry(self, request, pk=None):
        """Re-run the full pipeline for a capture, in the background.

        Available for `failed` captures (retry after fixing the cause)
        and `ready` ones (a full reprocess). Returns 202 with the
        capture; poll it for the new status.
        """
        capture = self.get_object()
        if capture.status not in (
            Capture.Status.FAILED,
            Capture.Status.READY,
        ):
            return Response(
                {
                    "detail": (
                        f"This capture is {capture.status.replace('_', ' ')}; "
                        "retry is available for failed or ready captures."
                    )
                },
                status=status.HTTP_409_CONFLICT,
            )
        pipeline.enqueue_capture_processing(capture)
        capture.refresh_from_db()
        return Response(
            self.get_serializer(capture).data,
            status=status.HTTP_202_ACCEPTED,
        )


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
        the generated (text, image, video, audio) context values plus
        the unified summary. The implementation lives in core.pipeline
        (shared with the background worker); this is a thin delegate so
        create()/partial_update() keep their shape."""
        return pipeline.extract_contexts(capture)

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
            summary_text,
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
                    summary_text=summary_text or None,
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
            summary_text,
        ) = self._extract_contexts(context.capture_id)

        context.text_context = text_context
        context.image_context = image_context
        context.video_context = video_context
        context.audio_context = audio_context
        # Always rewritten from the fresh extraction: on a failed
        # regeneration this clears the stale summary instead of leaving
        # a summary of the old content next to the new contexts.
        context.summary_text = summary_text or None

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


class SearchViewSet(GenericViewSet):
    """Semantic search over the authenticated user's captures.

    Contract:
      GET /search/?q=<text>[&k=<n>][&min_score=<f>]

    `q` (the text to search for) is required; missing/blank → 400.
    `k` caps the number of captures and `min_score` is a floor on the
    capture's best-chunk score; both optional, and both off by default
    — every capture is returned so the caller can see the full score
    distribution before choosing a threshold.

    One paced Gemini embedding call per request embeds the query; the
    viewset doesn't care which model produces it — the provider is the
    source of truth. Results: unique captures ranked best-first, each
    carrying all of its chunks (best-first) with per-chunk scores.
    Read-only: no DB rows are written.
    """

    serializer_class = SearchResultSerializer
    permission_classes = [IsAuthenticated]

    http_method_names = ["get"]

    @staticmethod
    def _bad(message):
        return Response({"detail": message}, status=status.HTTP_400_BAD_REQUEST)

    @classmethod
    def _parse_limits(cls, query_params):
        """Return (k, min_score, error_response) from the query params.
        Absent params stay None (= off)."""

        k = None
        min_score = None

        if query_params.get("k") is not None:
            try:
                k = int(query_params["k"])
            except ValueError:
                return None, None, cls._bad("k must be a positive integer.")
            if k < 1:
                return None, None, cls._bad("k must be a positive integer.")

        if query_params.get("min_score") is not None:
            try:
                min_score = float(query_params["min_score"])
            except ValueError:
                return None, None, cls._bad("min_score must be a number.")
            if not math.isfinite(min_score):
                return None, None, cls._bad("min_score must be a finite number.")

        return k, min_score, None

    def list(self, request, *args, **kwargs):
        query = (request.query_params.get("q") or "").strip()

        if not query:
            return self._bad("q is required (the text to search for).")

        k, min_score, error = self._parse_limits(request.query_params)

        if error:
            return error

        results = search_captures(
            request.user, query, k=k, min_score=min_score
        )

        return Response(self.get_serializer(results, many=True).data)
