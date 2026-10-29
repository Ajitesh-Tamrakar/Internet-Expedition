import base64
import contextlib
import io
import json
import os
import re
import shutil
import tempfile
import time
from datetime import timedelta
import uuid
from unittest.mock import MagicMock, patch

from django.core.exceptions import ImproperlyConfigured
from django.core.files import File
from django.core.files.base import ContentFile
from django.core.files.storage import FileSystemStorage
from django.core.files.uploadedfile import SimpleUploadedFile

from allauth.account.models import EmailAddress
from django.conf import settings as django_settings
from django.contrib.auth import get_user_model
from django.core import mail
from django.test import TestCase, override_settings
from django.utils import timezone
from google.genai import errors
from rest_framework.test import APITestCase

from core import storage as media_storage
from core.api.serializers import CaptureSerializer
from core.api.gemini import EMBED_DIMENSIONS, GeminiProvider, is_window_overflow
from core.embedding_builder import (
    EXPECTED_DIMENSIONS,
    build_capture_embeddings,
    collect_units,
)
from core.models import (
    Capture,
    CaptureContext,
    CaptureEmbedding,
    ProviderRateSlot,
)
from core.pipeline import (
    NoUsableContentError,
    build_unified_text,
    enqueue_capture_processing,
    extract_contexts,
    process_capture,
    sweep_stuck_captures,
)
from core.search import PREVIEW_CHARS, search_captures
from core.storage import (
    SupabaseStorage,
    extension_for,
    fetchable_reference,
    ingest_capture_media,
    is_external_url,
    media_failure_summary,
    media_object_path,
    resolve_source,
    screenshot_upload_to,
)

DIM = EXPECTED_DIMENSIONS  # what the provider is configured to produce (Matryoshka)


class FakeProvider:
    """In-test stand-in for GeminiProvider: no pacing, no network.

    Returns one (text, vector) pair per generate_embeddings call. Set
    fail_on_text to simulate a failed embed for a specific text; set
    fail_summary to simulate a failed unified summary; set fail_text
    to simulate a failed text summarization.
    """

    def __init__(
        self,
        dimensions=DIM,
        fail_on_text=None,
        summary="A unified summary.",
        fail_summary=False,
        fail_text=False,
    ):
        self.dimensions = dimensions
        self.fail_on_text = fail_on_text
        self.summary = summary
        self.fail_summary = fail_summary
        self.fail_text = fail_text
        self.embed_calls: list[str] = []
        self.unified_calls: list[str] = []

    def generate_embeddings(self, text):
        self.embed_calls.append(text)
        if self.fail_on_text and text == self.fail_on_text:
            raise RuntimeError("simulated embed failure")
        return [(text, [0.0] * self.dimensions)]

    def summarize_text(self, text):
        if self.fail_text:
            raise RuntimeError("simulated text summarization failure")
        return f"summarized: {text}"

    def unified_context(self, unified_text):
        self.unified_calls.append(unified_text)
        if self.fail_summary:
            raise RuntimeError("simulated summary failure")
        return self.summary


def _make_capture_context(user, text_context="hello world"):
    capture = Capture.objects.create(user=user)
    return capture, CaptureContext.objects.create(
        user=user,
        capture_id=capture,
        text_context=text_context,
        image_context=[{"id": "img-1", "context": "a red truck"}],
        summary_text="A capture about a red truck",
    )


class CollectUnitsTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            "u", "u@example.com", "pw"
        )

    def test_order_and_empty_skip(self):
        _, context = _make_capture_context(self.user)
        context.text_context = "   "  # whitespace-only → skipped
        context.image_context = [
            {"id": "img-1", "context": "a red truck"},
            {"id": "img-2", "context": "   "},  # empty → skipped
        ]
        context.video_context = [{"id": "vid-1", "context": "an engine idling"}]
        context.audio_context = None  # null → nothing
        context.summary_text = None  # not generated yet → nothing

        units = collect_units(context)
        self.assertEqual(
            [(t, ref) for t, ref, _ in units],
            [("image", "img-1"), ("video", "vid-1")],
        )

    def test_full_order(self):
        _, context = _make_capture_context(self.user)
        units = collect_units(context)
        self.assertEqual(
            [(t, ref) for t, ref, _ in units],
            [("text", "context"), ("image", "img-1"), ("summary", "global")],
        )

    def test_all_empty_returns_nothing(self):
        capture, context = _make_capture_context(self.user)
        context.text_context = ""
        context.image_context = []
        context.summary_text = ""
        self.assertEqual(collect_units(context), [])
        self.assertEqual(build_capture_embeddings(context, provider=FakeProvider()),
                         {"sources": 0, "rows": 0})
        self.assertEqual(
            CaptureEmbedding.objects.filter(capture_id=capture).count(), 0
        )


class BuildTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            "u", "u@example.com", "pw"
        )
        self.capture, self.context = _make_capture_context(self.user)

    def test_writes_expected_rows(self):
        result = build_capture_embeddings(self.context, provider=FakeProvider())
        self.assertEqual(result, {"sources": 3, "rows": 3})
        keys = set(
            CaptureEmbedding.objects.filter(capture_id=self.capture)
            .values_list("source_key", flat=True)
        )
        self.assertEqual(
            keys, {"text:context:0", "image:img-1:0", "summary:global:0"}
        )
        row = CaptureEmbedding.objects.get(
            capture_id=self.capture, source_key="image:img-1:0"
        )
        self.assertEqual(row.text, "a red truck")
        self.assertEqual(row.embedding_model, "gemini-embedding-2")
        self.assertEqual(row.user, self.user)
        self.assertEqual(len(row.embedding), DIM)

    def test_rerun_is_idempotent(self):
        build_capture_embeddings(self.context, provider=FakeProvider())
        build_capture_embeddings(self.context, provider=FakeProvider())
        self.assertEqual(
            CaptureEmbedding.objects.filter(capture_id=self.capture).count(), 3
        )

    def test_chunk_count_change_leaves_no_stale_rows(self):
        # Simulate an older build with 3 chunks of the text unit.
        CaptureEmbedding.objects.bulk_create(
            CaptureEmbedding(
                user=self.user,
                capture_id=self.capture,
                source_key=f"text:context:{i}",
                text=f"old chunk {i}",
                embedding=[0.0] * DIM,
                embedding_model="gemini-embedding-2",
            )
            for i in range(3)
        )
        result = build_capture_embeddings(self.context, provider=FakeProvider())
        self.assertEqual(result, {"sources": 3, "rows": 3})
        text_rows = list(
            CaptureEmbedding.objects.filter(
                capture_id=self.capture, source_key__startswith="text:context:"
            ).values_list("source_key", "text")
        )
        self.assertEqual(text_rows, [("text:context:0", "hello world")])

    def test_all_or_nothing_on_failure(self):
        self.context.image_context[0]["context"] = "a red truck"
        build_capture_embeddings(self.context, provider=FakeProvider())
        self.assertEqual(
            CaptureEmbedding.objects.filter(capture_id=self.capture).count(), 3
        )

        # Now the text unit fails mid-build: nothing new is written and
        # the previous rows survive.
        self.context.text_context = "some other text"
        with self.assertRaises(RuntimeError):
            build_capture_embeddings(
                self.context, provider=FakeProvider(fail_on_text="some other text")
            )
        rows = list(
            CaptureEmbedding.objects.filter(capture_id=self.capture)
            .order_by("source_key")
            .values_list("source_key", flat=True)
        )
        self.assertEqual(
            rows, ["image:img-1:0", "summary:global:0", "text:context:0"]
        )
        # The failed source keeps its previous row.
        self.assertEqual(
            CaptureEmbedding.objects.get(
                capture_id=self.capture, source_key="text:context:0"
            ).text,
            "hello world",
        )

    def test_rejects_wrong_dimension(self):
        with self.assertRaises(ValueError):
            build_capture_embeddings(self.context, provider=FakeProvider(dimensions=768))
        self.assertEqual(
            CaptureEmbedding.objects.filter(capture_id=self.capture).count(), 0
        )


def _provider_with_fake_client():
    """GeminiProvider without __init__ (no API key) and no pacing."""
    provider = GeminiProvider.__new__(GeminiProvider)
    provider.client = MagicMock()
    return provider


class GeminiEmbeddingWindowTests(TestCase):
    def test_fastpath_short_text_skips_count(self):
        provider = _provider_with_fake_client()
        provider.client.models.embed_content.return_value = MagicMock(
            embeddings=[MagicMock(values=[0.0] * DIM)]
        )
        with patch.object(GeminiProvider, "_pace", lambda self: None):
            pairs = provider.generate_embeddings("short text")
        self.assertEqual(len(pairs), 1)
        self.assertEqual(pairs[0][0], "short text")
        self.assertEqual(len(pairs[0][1]), DIM)
        provider.client.models.count_tokens.assert_not_called()
        provider.client.models.embed_content.assert_called_once()
        # The Matryoshka compression is requested on the API call itself.
        embed_kwargs = provider.client.models.embed_content.call_args.kwargs
        self.assertEqual(embed_kwargs["config"].output_dimensionality, EMBED_DIMENSIONS)

    def test_long_text_is_split_validated_and_embedded(self):
        provider = _provider_with_fake_client()
        # Fake counter by length: anything big "measures" 9000 tokens
        # (over the 8192 window → re-split), anything smaller measures
        # 4000 (fits).
        provider.client.models.count_tokens.side_effect = lambda **kw: MagicMock(
            total_tokens=9000 if len(kw["contents"]) > 15000 else 4000
        )
        provider.client.models.embed_content.return_value = MagicMock(
            embeddings=[MagicMock(values=[0.0] * DIM)]
        )

        with patch.object(GeminiProvider, "_pace", lambda self: None):
            # 20000 chars → past the fast path; the over-window piece is
            # re-split until every piece fits.
            pairs = provider.generate_embeddings("word " * 4000)

        self.assertGreater(len(pairs), 1)
        # Each final piece was validated (≥ one count per piece + one
        # for the original) and embedded exactly once.
        self.assertGreaterEqual(provider.client.models.count_tokens.call_count, 2)
        self.assertEqual(
            provider.client.models.embed_content.call_count, len(pairs)
        )
        for chunk_text, vector in pairs:
            self.assertEqual(len(vector), DIM)
        # Every embed call requested the configured output dimension.
        for call in provider.client.models.embed_content.call_args_list:
            self.assertEqual(
                call.kwargs["config"].output_dimensionality, EMBED_DIMENSIONS
            )

    def test_empty_text_yields_nothing(self):
        provider = _provider_with_fake_client()
        self.assertEqual(provider.generate_embeddings("   "), [])
        self.assertEqual(provider.generate_embeddings(""), [])


class CaptureEmbeddingApiTests(APITestCase):
    def setUp(self):
        self.user_a = get_user_model().objects.create_user(
            "a", "a@example.com", "pw"
        )
        self.user_b = get_user_model().objects.create_user(
            "b", "b@example.com", "pw"
        )
        self.capture = Capture.objects.create(user=self.user_a)
        self.context = CaptureContext.objects.create(
            user=self.user_a,
            capture_id=self.capture,
            text_context="hello world",
        )
        CaptureEmbedding.objects.create(
            user=self.user_a,
            capture_id=self.capture,
            source_key="text:context:0",
            text="hello world",
            embedding=[0.0] * DIM,
            embedding_model="gemini-embedding-2",
        )

    def test_post_without_context_is_400(self):
        other = Capture.objects.create(user=self.user_a)
        self.client.force_authenticate(self.user_a)
        response = self.client.post(f"/capture-embedding/{other.capture_id}/")
        self.assertEqual(response.status_code, 400)
        self.assertIn("capture-context", str(response.data["detail"]))

    def test_post_other_users_capture_is_404(self):
        self.client.force_authenticate(self.user_b)
        response = self.client.post(f"/capture-embedding/{self.capture.capture_id}/")
        self.assertEqual(response.status_code, 404)

    def test_post_query_param_form_is_rejected(self):
        # The capture id belongs in the URL on POST — the ?capture_id=
        # query form is rejected (same contract as the context endpoint).
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            f"/capture-embedding/{self.capture.capture_id}/?capture_id=x"
        )
        self.assertEqual(response.status_code, 400)

    @patch("core.api.views.build_capture_embeddings")
    def test_post_success(self, mock_build):
        mock_build.return_value = {"sources": 1, "rows": 1}
        self.client.force_authenticate(self.user_a)
        response = self.client.post(f"/capture-embedding/{self.capture.capture_id}/")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["sources"], 1)
        self.assertEqual(response.data["rows"], 1)
        self.assertEqual(len(response.data["embeddings"]), 1)
        self.assertEqual(response.data["embeddings"][0]["source_key"], "text:context:0")
        self.assertNotIn("embedding", response.data["embeddings"][0])  # never the vector
        mock_build.assert_called_once()

    @patch("core.api.views.build_capture_embeddings", side_effect=RuntimeError("boom"))
    def test_post_failure_is_500(self, mock_build):
        # Uncaught view exceptions propagate through the test client by
        # default; opt out so we can assert on the resulting 500.
        self.client.raise_request_exception = False
        self.client.force_authenticate(self.user_a)
        response = self.client.post(f"/capture-embedding/{self.capture.capture_id}/")
        self.assertEqual(response.status_code, 500)

    def test_get_other_users_capture_is_404(self):
        # Isolation: a capture that isn't yours 404s (never leaks that
        # it exists) — same semantics as the context endpoints.
        self.client.force_authenticate(self.user_b)
        response = self.client.get(
            "/capture-embedding/", {"capture_id": str(self.capture.capture_id)}
        )
        self.assertEqual(response.status_code, 404)

    def test_get_own_capture_lists_rows(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.get(
            "/capture-embedding/", {"capture_id": str(self.capture.capture_id)}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]["source_key"], "text:context:0")


class BuildUnifiedTextTests(TestCase):
    def test_only_populated_sections_appear(self):
        unified = build_unified_text(
            text_context="  some text  ",
            image_context=[
                {"id": "i1", "context": "a red truck"},
                {"id": "i2", "context": "   "},  # whitespace-only → skipped
            ],
            video_context=None,  # null → nothing
            audio_context=[],
        )
        self.assertEqual(
            unified, "[TEXT]\nsome text\n\n[IMAGE i1]\na red truck"
        )

    def test_all_empty_returns_blank(self):
        self.assertEqual(build_unified_text("", [], None, []), "")


class GeminiUnifiedContextTests(TestCase):
    def test_single_guarded_call_returns_summary(self):
        provider = _provider_with_fake_client()
        provider.client.models.generate_content.return_value = MagicMock(
            text="  the summary  "
        )
        with patch.object(GeminiProvider, "_pace", lambda self: None):
            out = provider.unified_context("[TEXT]\nhello world")
        self.assertEqual(out, "the summary")
        # Paced + guarded: exactly one generate_content call, prompt + doc.
        provider.client.models.generate_content.assert_called_once()
        contents = provider.client.models.generate_content.call_args.kwargs[
            "contents"
        ]
        self.assertIn("[TEXT]\nhello world", contents)

    def test_empty_input_makes_no_call(self):
        provider = _provider_with_fake_client()
        self.assertEqual(provider.unified_context("   "), "")
        provider.client.models.generate_content.assert_not_called()


class IsWindowOverflowTests(TestCase):
    def _err(self, code, message):
        err = errors.ClientError.__new__(errors.ClientError)
        err.code = code
        err.message = message
        return err

    def test_flags_400_window_messages(self):
        self.assertTrue(is_window_overflow(self._err(400, "Prompt is too long.")))
        self.assertTrue(
            is_window_overflow(
                self._err(400, "Request payload size exceeds limit.")
            )
        )

    def test_ignores_other_errors(self):
        self.assertFalse(
            is_window_overflow(self._err(429, "Resource has been exhausted"))
        )
        self.assertFalse(is_window_overflow(RuntimeError("too long")))


class CaptureContextApiTests(APITestCase):
    def setUp(self):
        self.user_a = get_user_model().objects.create_user(
            "a", "a@example.com", "pw"
        )
        self.user_b = get_user_model().objects.create_user(
            "b", "b@example.com", "pw"
        )

    @patch("core.pipeline.GeminiProvider")
    def test_post_creates_context_with_summary(self, mock_provider_cls):
        fake = FakeProvider()
        mock_provider_cls.return_value = fake
        capture = Capture.objects.create(
            user=self.user_a,
            text_sources=["an article about red trucks"],
        )
        self.client.force_authenticate(self.user_a)
        response = self.client.post(f"/capture-context/{capture.capture_id}/")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(
            response.data["text_context"],
            "summarized: an article about red trucks",
        )
        self.assertEqual(response.data["summary_text"], "A unified summary.")
        # The summary ran exactly once, over the populated sections only.
        self.assertEqual(len(fake.unified_calls), 1)
        self.assertIn("[TEXT]", fake.unified_calls[0])
        context = CaptureContext.objects.get(capture_id=capture)
        self.assertEqual(context.summary_text, "A unified summary.")

    @patch("core.pipeline.GeminiProvider")
    def test_post_summary_failure_still_saves_context(self, mock_provider_cls):
        # The summary is an optional path: a failed summary must not
        # prevent the capture from being processed and saved.
        mock_provider_cls.return_value = FakeProvider(fail_summary=True)
        capture = Capture.objects.create(
            user=self.user_a,
            text_sources=["an article about red trucks"],
        )
        self.client.force_authenticate(self.user_a)
        response = self.client.post(f"/capture-context/{capture.capture_id}/")
        self.assertEqual(response.status_code, 201)
        context = CaptureContext.objects.get(capture_id=capture)
        self.assertEqual(
            context.text_context, "summarized: an article about red trucks"
        )
        self.assertIsNone(context.summary_text)
        self.assertIsNone(response.data["summary_text"])

    @patch("core.pipeline.GeminiProvider")
    def test_post_all_empty_capture_skips_summary_call(self, mock_provider_cls):
        fake = FakeProvider()
        mock_provider_cls.return_value = fake
        capture = Capture.objects.create(user=self.user_a)  # no sources at all
        self.client.force_authenticate(self.user_a)
        response = self.client.post(f"/capture-context/{capture.capture_id}/")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(fake.unified_calls, [])  # no paced call burned
        self.assertIsNone(
            CaptureContext.objects.get(capture_id=capture).summary_text
        )

    @patch("core.pipeline.GeminiProvider")
    def test_post_other_users_capture_is_404(self, mock_provider_cls):
        mock_provider_cls.return_value = FakeProvider()
        capture = Capture.objects.create(user=self.user_a)
        self.client.force_authenticate(self.user_b)
        response = self.client.post(f"/capture-context/{capture.capture_id}/")
        self.assertEqual(response.status_code, 404)

    @patch("core.pipeline.GeminiProvider")
    def test_patch_refreshes_stale_summary(self, mock_provider_cls):
        mock_provider_cls.return_value = FakeProvider(summary="the new summary")
        capture = Capture.objects.create(
            user=self.user_a,
            text_sources=["an article about red trucks"],
        )
        context = CaptureContext.objects.create(
            user=self.user_a, capture_id=capture, summary_text="stale summary"
        )
        self.client.force_authenticate(self.user_a)
        response = self.client.patch(
            f"/capture-context/{context.capture_context_id}/"
        )
        self.assertEqual(response.status_code, 200)
        context.refresh_from_db()
        self.assertEqual(context.summary_text, "the new summary")

    @patch("core.pipeline.GeminiProvider")
    def test_patch_summary_failure_clears_stale_summary(self, mock_provider_cls):
        # A failed regeneration must not leave a summary of the OLD
        # content sitting next to the refreshed contexts.
        mock_provider_cls.return_value = FakeProvider(fail_summary=True)
        capture = Capture.objects.create(
            user=self.user_a,
            text_sources=["an article about red trucks"],
        )
        context = CaptureContext.objects.create(
            user=self.user_a, capture_id=capture, summary_text="stale summary"
        )
        self.client.force_authenticate(self.user_a)
        response = self.client.patch(
            f"/capture-context/{context.capture_context_id}/"
        )
        self.assertEqual(response.status_code, 200)
        context.refresh_from_db()
        self.assertIsNone(context.summary_text)

    @patch("core.storage.get_storage")
    @patch("core.storage.requests.get")
    @patch("core.pipeline.GeminiProvider")
    def test_post_all_failed_media_is_409(self, mock_provider_cls, fake_get, storage):
        # Every item dies at both stages: the endpoint must answer with a
        # clean 409 and the failure summary, not a 500 — and must not
        # leave a zombie context row behind.
        import shutil as _shutil

        tmp = tempfile.mkdtemp(prefix="bm-media-")
        self.addCleanup(_shutil.rmtree, tmp, True)
        storage.return_value = _local_storage(tmp)
        fake_get.side_effect = lambda url, **kw: _fake_get_response(status_code=403)
        mock_provider_cls.return_value = MediaFakeProvider(
            fail_on={"https://origin.example/a.jpg"}
        )
        capture = Capture.objects.create(
            user=self.user_a,
            image_sources=[{"id": "i1", "url": "https://origin.example/a.jpg"}],
        )
        self.client.force_authenticate(self.user_a)
        response = self.client.post(f"/capture-context/{capture.capture_id}/")

        self.assertEqual(response.status_code, 409)
        self.assertIn("a.jpg", response.data["detail"])
        self.assertFalse(
            CaptureContext.objects.filter(capture_id=capture).exists()
        )

    @patch("core.storage.get_storage")
    @patch("core.storage.requests.get")
    @patch("core.pipeline.GeminiProvider")
    def test_post_degraded_media_saves_with_marker(
        self, mock_provider_cls, fake_get, storage
    ):
        # One dead image, but text survives: the context is saved (201)
        # with the failed item represented as an empty marker.
        import shutil as _shutil

        tmp = tempfile.mkdtemp(prefix="bm-media-")
        self.addCleanup(_shutil.rmtree, tmp, True)
        storage.return_value = _local_storage(tmp)

        def fake_get_side_effect(url, **kw):
            if url.endswith("b.png"):
                return _fake_get_response(status_code=404)
            return _fake_get_response(b"img")

        fake_get.side_effect = fake_get_side_effect
        mock_provider_cls.return_value = MediaFakeProvider(
            fail_on={"https://origin.example/b.png"}
        )
        capture = Capture.objects.create(
            user=self.user_a,
            text_sources=["an article about red trucks"],
            image_sources=[
                {"id": "i1", "url": "https://origin.example/a.jpg"},
                {"id": "i2", "url": "https://origin.example/b.png"},
            ],
        )
        self.client.force_authenticate(self.user_a)
        response = self.client.post(f"/capture-context/{capture.capture_id}/")

        self.assertEqual(response.status_code, 201)
        by_id = {item["id"]: item for item in response.data["image_context"]}
        self.assertNotIn("status", by_id["i1"])
        self.assertEqual(by_id["i2"]["status"], "download_failed")
        self.assertEqual(by_id["i2"]["context"], "")


def _stale_delta():
    """How far back to backdate updated_at to count as 'abandoned'."""
    minutes = getattr(django_settings, "CAPTURE_STALE_MINUTES", 50)
    return timedelta(minutes=minutes + 10)


class PipelineTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            "u", "u@example.com", "pw"
        )
        self.capture = Capture.objects.create(
            user=self.user, text_sources=["an article about red trucks"]
        )

    @patch("core.pipeline.GeminiProvider")
    def test_process_capture_reaches_ready(self, mock_provider_cls):
        mock_provider_cls.return_value = FakeProvider()

        process_capture(str(self.capture.capture_id))

        self.capture.refresh_from_db()
        self.assertEqual(self.capture.status, Capture.Status.READY)
        self.assertIsNone(self.capture.error_note)
        context = CaptureContext.objects.get(capture_id=self.capture)
        self.assertEqual(
            context.text_context, "summarized: an article about red trucks"
        )
        self.assertEqual(context.summary_text, "A unified summary.")
        # Embeddings: the text unit + the summary unit.
        self.assertEqual(
            CaptureEmbedding.objects.filter(capture_id=self.capture).count(), 2
        )

    @patch("core.pipeline.GeminiProvider")
    def test_context_phase_failure_lands_failed(self, mock_provider_cls):
        mock_provider_cls.return_value = FakeProvider(fail_text=True)

        with self.assertRaises(RuntimeError):
            process_capture(str(self.capture.capture_id))

        self.capture.refresh_from_db()
        self.assertEqual(self.capture.status, Capture.Status.FAILED)
        self.assertIn("summarization failure", self.capture.error_note)
        self.assertFalse(
            CaptureContext.objects.filter(capture_id=self.capture).exists()
        )

    @patch("core.pipeline.GeminiProvider")
    def test_embedding_phase_failure_lands_failed(self, mock_provider_cls):
        # The context phase succeeds and saves; the embed of the stored
        # text fails.
        mock_provider_cls.return_value = FakeProvider(
            fail_on_text="summarized: an article about red trucks"
        )

        with self.assertRaises(RuntimeError):
            process_capture(str(self.capture.capture_id))

        self.capture.refresh_from_db()
        self.assertEqual(self.capture.status, Capture.Status.FAILED)
        self.assertIn("simulated embed failure", self.capture.error_note)
        # The context survived (saved in its own phase); the all-or-
        # nothing embedding build wrote nothing.
        self.assertTrue(
            CaptureContext.objects.filter(capture_id=self.capture).exists()
        )
        self.assertEqual(
            CaptureEmbedding.objects.filter(capture_id=self.capture).count(), 0
        )

    @patch("core.pipeline.GeminiProvider")
    def test_rerun_of_ready_capture_is_skipped(self, mock_provider_cls):
        fake = FakeProvider()
        mock_provider_cls.return_value = fake
        process_capture(str(self.capture.capture_id))

        # A duplicate/redelivered task for a finished capture is a
        # no-op: no API work at all.
        mock_provider_cls.return_value = FakeProvider()
        process_capture(str(self.capture.capture_id))

        self.assertEqual(len(fake.unified_calls), 1)
        self.assertEqual(len(fake.embed_calls), 2)

    @patch("core.pipeline.GeminiProvider")
    def test_rerun_of_abandoned_capture_is_reclaimed(self, mock_provider_cls):
        # A worker that died mid-processing: status stuck and
        # updated_at old. The re-run must claim it and finish it.
        self.capture.status = Capture.Status.PROCESSING_CONTEXT
        self.capture.save()
        Capture.objects.filter(pk=self.capture.pk).update(
            updated_at=timezone.now() - _stale_delta()
        )

        mock_provider_cls.return_value = FakeProvider()
        process_capture(str(self.capture.capture_id))

        self.capture.refresh_from_db()
        self.assertEqual(self.capture.status, Capture.Status.READY)

    @patch("core.pipeline.GeminiProvider")
    def test_fresh_inflight_capture_not_stolen(self, mock_provider_cls):
        # A live worker owns this capture (fresh updated_at): a
        # duplicate task must not steal it.
        self.capture.status = Capture.Status.PROCESSING_CONTEXT
        self.capture.save()

        fake = FakeProvider()
        mock_provider_cls.return_value = fake
        process_capture(str(self.capture.capture_id))

        self.assertEqual(fake.unified_calls, [])  # nothing ran
        self.capture.refresh_from_db()
        self.assertEqual(self.capture.status, Capture.Status.PROCESSING_CONTEXT)


class EnqueueTests(TestCase):
    def setUp(self):
        self.user_a = get_user_model().objects.create_user(
            "a", "a@example.com", "pw"
        )
        self.user_b = get_user_model().objects.create_user(
            "b", "b@example.com", "pw"
        )

    @patch("core.pipeline.async_task")
    def test_enqueues_and_sets_pending(self, mock_async):
        capture = Capture.objects.create(
            user=self.user_a, text_sources=["x"]
        )

        self.assertTrue(enqueue_capture_processing(capture))

        capture.refresh_from_db()
        self.assertEqual(capture.status, Capture.Status.PENDING)
        mock_async.assert_called_once_with(
            "core.pipeline.process_capture", str(capture.capture_id)
        )

    @patch("core.pipeline.async_task")
    def test_inflight_cap_queues_excess(self, mock_async):
        for _ in range(2):  # fill the user's slots (default cap: 2)
            other = Capture.objects.create(user=self.user_a)
            Capture.objects.filter(pk=other.pk).update(
                status=Capture.Status.PENDING
            )
        capture = Capture.objects.create(user=self.user_a)

        self.assertFalse(enqueue_capture_processing(capture))

        capture.refresh_from_db()
        self.assertEqual(capture.status, Capture.Status.QUEUED)
        mock_async.assert_not_called()

    @patch("core.pipeline.async_task")
    def test_cap_is_per_user(self, mock_async):
        for _ in range(2):
            other = Capture.objects.create(user=self.user_b)
            Capture.objects.filter(pk=other.pk).update(
                status=Capture.Status.PROCESSING_CONTEXT
            )
        capture = Capture.objects.create(user=self.user_a)

        self.assertTrue(enqueue_capture_processing(capture))  # not blocked


class SweepTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            "u", "u@example.com", "pw"
        )

    @patch("core.pipeline.async_task")
    def test_requeues_abandoned_and_promotes_queued(self, mock_async):
        stuck = Capture.objects.create(
            user=self.user, status=Capture.Status.PROCESSING_CONTEXT
        )
        Capture.objects.filter(pk=stuck.pk).update(
            updated_at=timezone.now() - _stale_delta()
        )
        # Another user's fresh in-flight capture: a different user's
        # budget, so it is neither re-queued nor counted for `self.user`.
        other_user = get_user_model().objects.create_user(
            "o", "o@example.com", "pw"
        )
        fresh = Capture.objects.create(
            user=other_user, status=Capture.Status.PROCESSING_EMBEDDINGS
        )
        # After the abandoned one is re-queued, the user has 1 of 2
        # in-flight slots used -> the queued one is promoted.
        queued = Capture.objects.create(
            user=self.user, status=Capture.Status.QUEUED
        )

        requeued = sweep_stuck_captures()

        self.assertEqual(requeued, 2)  # the abandoned one + the promoted one
        stuck.refresh_from_db()
        fresh.refresh_from_db()
        queued.refresh_from_db()
        self.assertEqual(stuck.status, Capture.Status.PENDING)
        self.assertEqual(
            fresh.status, Capture.Status.PROCESSING_EMBEDDINGS
        )  # untouched
        self.assertEqual(queued.status, Capture.Status.PENDING)
        self.assertEqual(mock_async.call_count, 2)

    @patch("core.pipeline.async_task")
    def test_skips_healthy_backlog(self, mock_async):
        # A fresh pending capture (its queue row is alive) and a fresh
        # in-flight one: nothing to do.
        Capture.objects.create(user=self.user, status=Capture.Status.PENDING)
        Capture.objects.create(
            user=self.user, status=Capture.Status.PROCESSING_CONTEXT
        )

        self.assertEqual(sweep_stuck_captures(), 0)
        mock_async.assert_not_called()

    @patch("core.pipeline.async_task")
    def test_no_promotion_when_user_at_cap(self, mock_async):
        for _ in range(2):
            c = Capture.objects.create(user=self.user)
            Capture.objects.filter(pk=c.pk).update(
                status=Capture.Status.PENDING
            )
        queued = Capture.objects.create(
            user=self.user, status=Capture.Status.QUEUED
        )

        self.assertEqual(sweep_stuck_captures(), 0)

        queued.refresh_from_db()
        self.assertEqual(queued.status, Capture.Status.QUEUED)


class PaceSlotTests(TestCase):
    def test_slot_serializes_calls(self):
        provider = _provider_with_fake_client()
        provider.client.models.embed_content.return_value = MagicMock(
            embeddings=[MagicMock(values=[0.0] * DIM)]
        )
        with override_settings(GEMINI_CALL_GAP_SECONDS=0.3):
            start = time.monotonic()
            provider.generate_embedding("first")
            provider.generate_embedding("second")
            elapsed = time.monotonic() - start

        # The second call waited out the gap left by the first.
        self.assertGreaterEqual(elapsed, 0.2)
        self.assertIsNotNone(ProviderRateSlot.objects.get(key="gemini").last_call_at)

    def test_models_come_from_settings(self):
        provider = _provider_with_fake_client()
        provider.client.models.generate_content.return_value = MagicMock(text="s")
        with override_settings(GEMINI_SUMMARY_MODEL="custom-summary-model"):
            provider.unified_context("hello")
        kwargs = provider.client.models.generate_content.call_args.kwargs
        self.assertEqual(kwargs["model"], "custom-summary-model")


class CaptureApiAutomationTests(APITestCase):
    def setUp(self):
        self.user_a = get_user_model().objects.create_user(
            "a", "a@example.com", "pw"
        )
        self.user_b = get_user_model().objects.create_user(
            "b", "b@example.com", "pw"
        )

    @patch("core.pipeline.async_task")
    def test_post_capture_returns_201_with_pending(self, mock_async):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/", {"text": ["some text"]}, format="json"
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["status"], "pending")
        self.assertIn("error_note", response.data)
        self.assertIsNone(response.data["error_note"])
        self.assertEqual(mock_async.call_count, 1)

    @patch("core.pipeline.async_task")
    def test_post_capture_over_cap_queues(self, mock_async):
        self.client.force_authenticate(self.user_a)
        for _ in range(2):
            c = Capture.objects.create(user=self.user_a)
            Capture.objects.filter(pk=c.pk).update(status=Capture.Status.PENDING)
        response = self.client.post(
            "/captures/", {"text": ["some text"]}, format="json"
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["status"], "queued")
        mock_async.assert_not_called()

    @patch("core.pipeline.async_task")
    def test_retry_failed_capture(self, mock_async):
        capture = Capture.objects.create(user=self.user_a)
        Capture.objects.filter(pk=capture.pk).update(
            status=Capture.Status.FAILED, error_note="ValueError: bad media url"
        )
        self.client.force_authenticate(self.user_a)
        response = self.client.post(f"/captures/{capture.capture_id}/retry/")
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.data["status"], "pending")
        mock_async.assert_called_once()

    @patch("core.pipeline.async_task")
    def test_retry_pending_capture_is_409(self, mock_async):
        capture = Capture.objects.create(user=self.user_a)
        self.client.force_authenticate(self.user_a)
        response = self.client.post(f"/captures/{capture.capture_id}/retry/")
        self.assertEqual(response.status_code, 409)
        mock_async.assert_not_called()

    def test_get_capture_exposes_status(self):
        capture = Capture.objects.create(user=self.user_a)
        Capture.objects.filter(pk=capture.pk).update(
            status=Capture.Status.READY
        )
        other = Capture.objects.create(user=self.user_b)
        self.client.force_authenticate(self.user_a)
        response = self.client.get(f"/captures/{capture.capture_id}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["status"], "ready")
        # Isolation: someone else's capture 404s.
        response = self.client.get(f"/captures/{other.capture_id}/")
        self.assertEqual(response.status_code, 404)


class CaptureSourceMetadataTests(TestCase):
    """Section 1 (B1 + B2): source_url + metadata on Capture, model level.

    The test runner builds its database by applying the migrations, so a
    passing run is also the proof that migration 0006 applies cleanly.
    """

    def setUp(self):
        self.user = get_user_model().objects.create_user(
            "a", "a@example.com", "pw"
        )

    def test_absent_values_follow_the_sources_convention(self):
        # The additive columns are nullable; a plain ORM create leaves
        # source_url NULL and takes the model default for metadata.
        source_url = Capture._meta.get_field("source_url")
        self.assertTrue(source_url.null)
        self.assertTrue(source_url.blank)
        metadata = Capture._meta.get_field("metadata")
        self.assertTrue(metadata.null)
        self.assertTrue(metadata.blank)
        self.assertEqual(metadata.get_default(), {})

        capture = Capture.objects.create(user=self.user)
        capture.refresh_from_db()
        self.assertIsNone(capture.source_url)
        self.assertEqual(capture.metadata, {})

    def test_round_trip_preserves_values(self):
        capture = Capture.objects.create(
            user=self.user,
            source_url="https://example.com/article",
            metadata={"title": "Article title", "site": "example.com"},
        )
        capture.refresh_from_db()
        self.assertEqual(capture.source_url, "https://example.com/article")
        self.assertEqual(
            capture.metadata, {"title": "Article title", "site": "example.com"}
        )


class CaptureSourceMetadataApiTests(APITestCase):
    """POST /captures/ + GET /captures/<id>/ with source_url + metadata."""

    def setUp(self):
        self.user_a = get_user_model().objects.create_user(
            "a", "a@example.com", "pw"
        )
        patcher = patch("core.pipeline.async_task")
        patcher.start()
        self.addCleanup(patcher.stop)

    def _capture_from_response(self, response) -> Capture:
        return Capture.objects.get(
            capture_id=uuid.UUID(response.data["capture_id"])
        )

    def test_create_with_source_url_and_metadata_round_trips(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {
                "text": ["some text"],
                "source_url": "https://example.com/article",
                "metadata": {"title": "Article title", "site": "example.com"},
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(
            response.data["source_url"], "https://example.com/article"
        )
        self.assertEqual(
            response.data["metadata"],
            {"title": "Article title", "site": "example.com"},
        )
        # The row carries both, and a later retrieve returns both.
        capture = self._capture_from_response(response)
        self.assertEqual(capture.source_url, "https://example.com/article")
        self.assertEqual(
            capture.metadata, {"title": "Article title", "site": "example.com"}
        )
        response = self.client.get(f"/captures/{capture.capture_id}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data["source_url"], "https://example.com/article"
        )
        self.assertEqual(
            response.data["metadata"],
            {"title": "Article title", "site": "example.com"},
        )

    def test_create_without_metadata_or_source_url(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/", {"text": ["some text"]}, format="json"
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["metadata"], {})
        self.assertIsNone(response.data["source_url"])
        capture = self._capture_from_response(response)
        self.assertEqual(capture.metadata, {})
        self.assertIsNone(capture.source_url)

    def test_explicit_null_metadata_is_preserved(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {"text": ["some text"], "metadata": None},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertIsNone(response.data["metadata"])
        capture = self._capture_from_response(response)
        self.assertIsNone(capture.metadata)

    def test_non_object_metadata_is_rejected(self):
        self.client.force_authenticate(self.user_a)
        for bad in (["a", "list"], "a plain string", 42):
            with self.subTest(metadata=bad):
                response = self.client.post(
                    "/captures/",
                    {"text": ["some text"], "metadata": bad},
                    format="json",
                )
                self.assertEqual(response.status_code, 400)
        self.assertEqual(Capture.objects.count(), 0)

    def test_multipart_form_fields_round_trip(self):
        # The extension's path: source_url as a plain form field, metadata
        # as a JSON string.
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {
                "text": "some text",
                "source_url": "https://example.com/post",
                "metadata": json.dumps({"title": "Post", "lang": "en"}),
            },
            format="multipart",
        )
        self.assertEqual(response.status_code, 201, response.data)
        capture = self._capture_from_response(response)
        self.assertEqual(capture.source_url, "https://example.com/post")
        self.assertEqual(capture.metadata, {"title": "Post", "lang": "en"})

    def test_legacy_rows_still_serve(self):
        # A pre-migration row: both columns NULL. GET must still work.
        capture = Capture.objects.create(user=self.user_a)
        Capture.objects.filter(pk=capture.pk).update(
            metadata=None, source_url=None
        )
        self.client.force_authenticate(self.user_a)
        response = self.client.get(f"/captures/{capture.capture_id}/")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.data["metadata"])
        self.assertIsNone(response.data["source_url"])


class CaptureMetadataMergeApiTests(APITestCase):
    """Section 4 (B3 + B4 + B5): the schema-aware capture serializer.

    Recognized model fields validate against their own columns; eligible
    extra top-level fields merge into the JSON ``metadata``; explicit
    ``metadata`` wins key conflicts; server-managed fields are
    untouchable; the merged object is gated on structure and size.
    """

    def setUp(self):
        self.user_a = get_user_model().objects.create_user(
            "a", "a@example.com", "pw"
        )
        self.user_b = get_user_model().objects.create_user(
            "b", "b@example.com", "pw"
        )
        # Stored media must land in a throwaway root, not the repo's.
        ctx = _isolated_media_root()
        self.tmp_root = ctx.__enter__()
        self.addCleanup(ctx.__exit__, None, None, None)
        patcher = patch("core.pipeline.async_task")
        patcher.start()
        self.addCleanup(patcher.stop)

    def _capture_from_response(self, response) -> Capture:
        return Capture.objects.get(
            capture_id=uuid.UUID(response.data["capture_id"])
        )

    def test_multipart_file_parts_are_contract_not_metadata(self):
        # DRF merges uploaded file parts into request.data (that is how
        # declared file fields read them); they must never be swept
        # into metadata as if they were extra fields.
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {
                "text": "some text",
                "media": json.dumps(
                    {"images": [{"url": "https://origin.example/a.jpg"}]}
                ),
                "file:images:0": SimpleUploadedFile(
                    "a.jpg", b"image-bytes", content_type="image/jpeg"
                ),
            },
            format="multipart",
        )
        self.assertEqual(response.status_code, 201, response.data)
        capture = self._capture_from_response(response)
        self.assertEqual(capture.metadata, {})
        # ...and the file part is still stored through the normal path.
        self.assertEqual(len(capture.image_sources), 1)
        self.assertTrue(
            os.path.exists(os.path.join(self.tmp_root, capture.image_sources[0]["url"]))
        )

    def test_dedicated_field_lands_in_its_column_not_metadata(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {
                "text": ["some text"],
                "source_url": "https://example.com/article",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        capture = self._capture_from_response(response)
        self.assertEqual(capture.source_url, "https://example.com/article")
        # A recognized field stores in its own column, never swept into
        # metadata as if it were an extra field.
        self.assertEqual(capture.metadata, {})

    def test_explicit_metadata_is_saved_and_returned(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {
                "text": ["some text"],
                "metadata": {"title": "T", "site": "example.com"},
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(
            response.data["metadata"], {"title": "T", "site": "example.com"}
        )
        capture = self._capture_from_response(response)
        self.assertEqual(
            capture.metadata, {"title": "T", "site": "example.com"}
        )
        # Round trip: a later retrieve returns the stored object intact.
        response = self.client.get(f"/captures/{capture.capture_id}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data["metadata"], {"title": "T", "site": "example.com"}
        )

    def test_extra_fields_without_columns_are_collected_into_metadata(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {
                "text": ["some text"],
                "og_title": "Page title",
                "og_site": "example.com",
                "article_count": 3,
                "is_draft": False,
                "score": None,
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        capture = self._capture_from_response(response)
        self.assertEqual(
            capture.metadata,
            {
                "og_title": "Page title",
                "og_site": "example.com",
                "article_count": 3,
                "is_draft": False,
                "score": None,
            },
        )

    def test_omitted_metadata_with_extras_still_saves(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {"text": ["some text"], "og_title": "Page title"},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["metadata"], {"og_title": "Page title"})
        capture = self._capture_from_response(response)
        self.assertEqual(capture.metadata, {"og_title": "Page title"})

    def test_metadata_and_extras_combine_with_deterministic_conflict(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {
                "text": ["some text"],
                "metadata": {"title": "from-metadata"},
                "title": "from-top-level",
                "author": "a",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        capture = self._capture_from_response(response)
        # Neither side is lost, and the same-named key resolves
        # deterministically: the explicit metadata object wins.
        self.assertEqual(
            capture.metadata, {"title": "from-metadata", "author": "a"}
        )

    def test_multipart_extras_and_metadata_combine(self):
        # The extension's path: extras as plain form fields, the metadata
        # object as a JSON string; the same conflict rule applies.
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {
                "text": "some text",
                "metadata": json.dumps(
                    {"lang": "en", "title": "from-metadata"}
                ),
                "title": "from-top-level",
                "author": "a",
            },
            format="multipart",
        )
        self.assertEqual(response.status_code, 201, response.data)
        capture = self._capture_from_response(response)
        self.assertEqual(
            capture.metadata,
            {"lang": "en", "title": "from-metadata", "author": "a"},
        )

    def test_contract_fields_are_never_metadata(self):
        # `text`/`media`/`image` are request-level carriers (create()
        # consumes them): they must not be swept into metadata.
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {
                "text": ["some text"],
                "media": {"images": [{"url": "https://example.com/i.png"}]},
                "image": _png_data_uri(),
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        capture = self._capture_from_response(response)
        self.assertEqual(capture.metadata, {})

    def test_invalid_metadata_structures_are_rejected(self):
        self.client.force_authenticate(self.user_a)
        for bad in (["a", "list"], "a plain string", 42):
            with self.subTest(metadata=bad):
                response = self.client.post(
                    "/captures/",
                    {"text": ["some text"], "metadata": bad},
                    format="json",
                )
                self.assertEqual(response.status_code, 400)
        # A malformed JSON object on the extension's multipart path.
        response = self.client.post(
            "/captures/",
            {"text": "some text", "metadata": "{not json"},
            format="multipart",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Capture.objects.count(), 0)

    def test_overdeep_metadata_is_rejected(self):
        self.client.force_authenticate(self.user_a)
        from core.api.serializers import METADATA_MAX_DEPTH

        deep = {"a": "v"}
        for _ in range(METADATA_MAX_DEPTH + 2):
            deep = {"a": deep}
        response = self.client.post(
            "/captures/",
            {"text": ["some text"], "metadata": deep},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Capture.objects.count(), 0)

    def test_oversized_keys_are_rejected(self):
        self.client.force_authenticate(self.user_a)
        with override_settings(METADATA_MAX_KEY_LENGTH=8):
            response = self.client.post(
                "/captures/",
                {"text": ["some text"], "metadata": {"a" * 9: "v"}},
                format="json",
            )
            self.assertEqual(response.status_code, 400)
        # The same payload under the default limit (128) is fine.
        response = self.client.post(
            "/captures/",
            {"text": ["some text"], "metadata": {"a" * 9: "v"}},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(Capture.objects.count(), 1)

    def test_metadata_over_the_size_limit_is_rejected(self):
        self.client.force_authenticate(self.user_a)
        # Well under the 64 KiB default: fine.
        response = self.client.post(
            "/captures/",
            {"text": ["some text"], "metadata": {"blob": "x" * 1000}},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        # The limit is the setting: tighten it and the same payload is
        # rejected, along with anything merged in through an extra field.
        with override_settings(METADATA_MAX_SIZE=10):
            with self.subTest(carrier="metadata"):
                response = self.client.post(
                    "/captures/",
                    {
                        "text": ["some text"],
                        "metadata": {"blob": "x" * 1000},
                    },
                    format="json",
                )
                self.assertEqual(response.status_code, 400)
            with self.subTest(carrier="extra"):
                response = self.client.post(
                    "/captures/",
                    {"text": ["some text"], "big_extra": "x" * 1000},
                    format="json",
                )
                self.assertEqual(response.status_code, 400)
        self.assertEqual(Capture.objects.count(), 1)

    def test_server_managed_fields_cannot_be_overridden(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {
                "text": ["some text"],
                "user": self.user_b.pk,
                "capture_id": "11111111-1111-1111-1111-111111111111",
                "status": "ready",
                "error_note": "injected",
                "created_at": "2020-01-01T00:00:00Z",
                "updated_at": "2020-01-01T00:00:00Z",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        capture = self._capture_from_response(response)
        # Ownership, identity, and pipeline state are all server-managed:
        # the supplied values never land.
        self.assertEqual(capture.user_id, self.user_a.id)
        self.assertNotEqual(
            str(capture.capture_id), "11111111-1111-1111-1111-111111111111"
        )
        self.assertEqual(
            str(capture.capture_id), str(uuid.UUID(response.data["capture_id"]))
        )
        self.assertEqual(capture.status, Capture.Status.PENDING)
        self.assertIsNone(capture.error_note)
        self.assertGreater(
            capture.created_at, timezone.now() - timedelta(hours=1)
        )
        # ...and none of it leaks into metadata either.
        self.assertEqual(capture.metadata, {})

    def test_recognized_fields_are_the_model_schema_itself(self):
        # Schema awareness: "recognized" is the serializer's own field
        # map, which DRF builds from the model — with fields="__all__"
        # that is exactly the model's concrete fields, so no duplicate
        # list can drift from the schema.
        serializer = CaptureSerializer()
        model_fields = {field.name for field in Capture._meta.fields}
        self.assertEqual(set(serializer.fields), model_fields)
        # And behaviorally: a recognized key goes to its column, an
        # unrecognized one to metadata.
        result = serializer.to_internal_value(
            {"source_url": "https://example.com/", "brand_new_property": "v"}
        )
        self.assertEqual(result["source_url"], "https://example.com/")
        self.assertEqual(result["metadata"], {"brand_new_property": "v"})

    def test_create_retrieve_round_trip_is_consistent(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {
                "text": ["some text"],
                "source_url": "https://example.com/article",
                "metadata": {"site": "example.com"},
                "title": "Article title",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(
            response.data["metadata"],
            {"site": "example.com", "title": "Article title"},
        )
        capture = self._capture_from_response(response)
        response = self.client.get(f"/captures/{capture.capture_id}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data["source_url"], "https://example.com/article"
        )
        self.assertEqual(
            response.data["metadata"],
            {"site": "example.com", "title": "Article title"},
        )


# ---------------------------------------------------------------------------
# Authentication — django-allauth 65 (headless app client + built-in JWT)
#
# Replaces the old dj-rest-auth + Simple JWT + custom OneTimeToken system.
# These tests exercise the allauth headless *app* client contract as
# mounted under settings.AUTH_API_PREFIX (see docs/authentication.md for
# the full endpoint reference):
#
# * signup/login/verify are multi-stage flows resumed via the
#   ``X-Session-Token`` header (the value allauth returns in ``meta``);
# * once fully authenticated, allauth issues a signed JWT access token
#   (``HEADLESS_TOKEN_STRATEGY`` = the built-in JWT strategy, HS256
#   with the SECRET_KEY fallback) plus a refresh token;
# * core.auth.middleware moves the refresh token out of the JSON body
#   into an HttpOnly cookie (and back in for the refresh endpoint).
#
# allauth's headless responses are plain Django JsonResponse, not DRF
# responses: there is no ``.data`` attribute — parse ``response.content``.
# ---------------------------------------------------------------------------

import jwt as pyjwt

APP = f"{django_settings.AUTH_API_PREFIX}app/v1"
SIGNUP = f"{APP}/auth/signup"
LOGIN = f"{APP}/auth/login"
VERIFY = f"{APP}/auth/email/verify"
RESEND = f"{APP}/auth/email/verify/resend"
SESSION_URL = f"{APP}/auth/session"
REFRESH = f"{APP}/tokens/refresh"
CONFIG_URL = f"{APP}/config"
REFRESH_COOKIE = django_settings.AUTH_REFRESH_COOKIE_NAME


def _body(response):
    """Parse an allauth response body (plain JsonResponse, no .data)."""
    try:
        return json.loads(response.content.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None


def _code_from_last_mail():
    """The 6-digit verification code from the most recent email, if any."""
    if not mail.outbox:
        return None
    codes = re.findall(r"\b(\d{6})\b", mail.outbox[-1].body)
    return codes[-1] if codes else None


def _wrong_code(code: str) -> str:
    return "999999" if code != "999999" else "888888"


@override_settings(
    # allauth's cache-backed rate limits would otherwise leak between
    # tests; these target the by-code attempt/expiry semantics instead.
    ACCOUNT_RATE_LIMITS=False,
    # Pin the refresh-cookie attributes: settings default them off
    # DEBUG/.env, which varies between checkouts.
    AUTH_REFRESH_COOKIE_NAME="refresh_token",
    AUTH_REFRESH_COOKIE_PATH=f"{django_settings.AUTH_API_PREFIX}app/v1/tokens/",
    AUTH_REFRESH_COOKIE_DOMAIN="",
    AUTH_REFRESH_COOKIE_SECURE=True,
    AUTH_REFRESH_COOKIE_SAMESITE="Lax",
)
class AllauthAuthBase(APITestCase):
    PASSWORD = "s3c-ret-pass-1"

    def signup(self, email="ada@example.com", **extra):
        payload = {"email": email, "password": self.PASSWORD,
                   "first_name": "Ada", "last_name": "Lovelace"}
        payload.update(extra)
        return self.client.post(SIGNUP, payload, format="json")

    def resume(self, response):
        """Send the response's session_token as X-Session-Token."""
        meta = (_body(response) or {}).get("meta") or {}
        self.client.credentials(
            HTTP_X_SESSION_TOKEN=meta.get("session_token") or "")
        return meta

    def verify(self, key):
        return self.client.post(VERIFY, {"key": key}, format="json")

    def login(self, email, password=PASSWORD):
        return self.client.post(
            LOGIN, {"email": email, "password": password}, format="json")

    def bearer(self, access_token):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {access_token}")

    def verified_user(self, email="ada@example.com"):
        """signup + verify through to full authentication.

        Returns (user, meta) from the 200 verify response. The refresh
        token is in the client's cookie jar by the time this returns.
        """
        mail.outbox = []
        r = self.signup(email)
        self.assertEqual(r.status_code, 401)
        self.resume(r)
        code = _code_from_last_mail()
        self.assertIsNotNone(code)
        r = self.verify(code)
        self.assertEqual(r.status_code, 200)
        meta = (_body(r) or {}).get("meta") or {}
        return get_user_model().objects.get(email__iexact=email), meta


class SignupTests(AllauthAuthBase):
    def test_signup_creates_unverified_user_and_pending_flow(self):
        mail.outbox = []
        response = self.signup()
        # Signup completes but email verification is mandatory, so the
        # user is not yet authenticated: 401 + the pending flow.
        self.assertEqual(response.status_code, 401)
        body = _body(response)
        self.assertEqual(
            [(f["id"], f.get("is_pending")) for f in body["data"]["flows"]],
            [("login", None), ("signup", None),
             ("verify_email", True)])
        self.assertFalse(body["meta"]["is_authenticated"])
        self.assertTrue(body["meta"]["session_token"])
        # One email, carrying the 6-digit code; no tokens, no cookies.
        self.assertEqual(len(mail.outbox), 1)
        self.assertIsNotNone(_code_from_last_mail())
        self.assertNotIn("access_token", body["meta"])
        self.assertNotIn("refresh_token", json.dumps(body))
        self.assertFalse(response.cookies)

    def test_signup_persists_user_fields(self):
        self.signup("grace@example.com",
                    first_name="Grace", last_name="Hopper")
        user = get_user_model().objects.get(
            email__iexact="grace@example.com")
        self.assertEqual(user.first_name, "Grace")
        self.assertEqual(user.last_name, "Hopper")
        self.assertTrue(user.has_usable_password())
        email = EmailAddress.objects.get(email__iexact="grace@example.com")
        self.assertFalse(email.verified)
        self.assertTrue(email.primary)

    def test_duplicate_signup_keeps_flow_but_sends_no_code(self):
        mail.outbox = []
        first = self.signup()
        self.assertEqual(first.status_code, 401)
        code = _code_from_last_mail()
        self.resume(first)
        second = self.signup()
        self.assertEqual(second.status_code, 401)
        body = _body(second)
        # The session is unchanged (the client already has its token),
        # and the enumeration mail carries no code.
        self.assertNotIn("session_token", body["meta"])
        self.assertEqual(len(mail.outbox), 2)
        self.assertIsNone(_code_from_last_mail())
        # allauth's duplicate path re-issues the pending code without
        # emailing it, so the original (emailed) code is now invalid.
        self.assertEqual(self.verify(code).status_code, 400)

    def test_signup_while_authenticated_is_conflict(self):
        _, meta = self.verified_user()
        self.bearer(meta["access_token"])
        r = self.signup("other@example.com")
        self.assertEqual(r.status_code, 409)


class EmailVerificationTests(AllauthAuthBase):
    def test_verify_completes_login_and_issues_tokens(self):
        mail.outbox = []
        first = self.signup()
        session_token = self.resume(first)
        self.assertIn("session_token", session_token)
        response = self.verify(_code_from_last_mail())
        self.assertEqual(response.status_code, 200)
        body = _body(response)
        self.assertTrue(body["meta"]["is_authenticated"])
        # Login cycles the session key: the resumed token is dead, the
        # response carries the live one.
        self.assertNotEqual(body["meta"]["session_token"],
                            session_token["session_token"])
        self.assertTrue(body["meta"]["access_token"])
        # The refresh token left the body for the HttpOnly cookie.
        self.assertNotIn("refresh_token", json.dumps(body))
        self.assertIn(REFRESH_COOKIE, response.cookies)
        # The user payload carries the collected first/last names.
        self.assertEqual(body["data"]["user"]["first_name"], "Ada")
        self.assertEqual(body["data"]["user"]["last_name"], "Lovelace")
        self.assertEqual(body["data"]["user"]["email"], "ada@example.com")
        self.assertTrue(
            EmailAddress.objects.get(email__iexact="ada@example.com")
            .verified)

    def test_wrong_code_is_400(self):
        first = self.signup()
        self.resume(first)
        response = self.verify(_wrong_code(_code_from_last_mail()))
        self.assertEqual(response.status_code, 400)
        error = _body(response)["errors"][0]
        self.assertEqual(error["code"], "incorrect_code")
        self.assertEqual(error["param"], "key")

    def test_attempts_exhaust_flow(self):
        first = self.signup()
        self.resume(first)
        wrong = _wrong_code(_code_from_last_mail())
        # Each wrong code is a 400; the 3rd (== MAX_ATTEMPTS) consumes
        # the last attempt and aborts the pending flow on the way.
        for _ in range(3):
            self.assertEqual(self.verify(wrong).status_code, 400)
        # The flow is now dead: further verifies and resends 409.
        self.assertEqual(self.verify(wrong).status_code, 409)
        self.assertEqual(
            self.client.post(RESEND, format="json").status_code, 409)

    @override_settings(ACCOUNT_EMAIL_VERIFICATION_BY_CODE_TIMEOUT=1)
    def test_expired_code_is_conflict(self):
        first = self.signup()
        self.resume(first)
        time.sleep(1.1)
        self.assertEqual(self.verify("123456").status_code, 409)

    def test_resend_rotates_code_and_resends_mail(self):
        mail.outbox = []
        first = self.signup()
        self.resume(first)
        code = _code_from_last_mail()
        self.verify(_wrong_code(code))  # one consumed attempt
        mail.outbox = []
        response = self.client.post(RESEND, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(mail.outbox), 1)
        new_code = _code_from_last_mail()
        self.assertIsNotNone(new_code)
        self.assertNotEqual(new_code, code)
        # The rotated-out code is dead; the new one completes login.
        self.assertEqual(self.verify(code).status_code, 400)
        self.assertEqual(self.verify(new_code).status_code, 200)


class LoginTests(AllauthAuthBase):
    def test_login_verified_issues_tokens(self):
        self.verified_user()
        self.client.credentials()
        mail.outbox = []
        response = self.login("ada@example.com")
        self.assertEqual(response.status_code, 200)
        body = _body(response)
        self.assertTrue(body["meta"]["is_authenticated"])
        self.assertTrue(body["meta"]["access_token"])
        self.assertIn(REFRESH_COOKIE, response.cookies)
        self.assertEqual(len(mail.outbox), 0)

    def test_login_wrong_password_is_400(self):
        self.verified_user()
        self.client.credentials()  # the resumed session token is stale
        response = self.login("ada@example.com", password="WRONG-pass-99")
        self.assertEqual(response.status_code, 400)
        error = _body(response)["errors"][0]
        self.assertEqual(error["code"], "email_password_mismatch")
        self.assertEqual(error["param"], "password")

    def test_login_unknown_email_is_400_without_mail(self):
        mail.outbox = []
        response = self.login("ghost@example.com")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            _body(response)["errors"][0]["code"], "email_password_mismatch")
        self.assertEqual(len(mail.outbox), 0)  # enumeration prevention

    def test_login_unverified_offers_verification_and_self_heals(self):
        self.signup()  # leaves the user unverified
        self.client.credentials()  # the login starts a fresh session
        mail.outbox = []
        response = self.login("ada@example.com")
        self.assertEqual(response.status_code, 401)
        body = _body(response)
        flows = {f["id"]: f for f in body["data"]["flows"]}
        self.assertTrue(flows["verify_email"]["is_pending"])
        self.assertIn("session_token", body["meta"])
        self.assertNotIn("access_token", body["meta"])
        code = _code_from_last_mail()  # a fresh code was emailed
        self.assertIsNotNone(code)
        # Completing it logs the user in.
        self.resume(response)
        self.assertEqual(self.verify(code).status_code, 200)

    def test_stale_session_token_is_410(self):
        self.signup()
        self.client.credentials(HTTP_X_SESSION_TOKEN="not-a-real-session")
        self.assertEqual(self.login("ada@example.com").status_code, 410)


class AccessTokenTests(AllauthAuthBase):
    def test_valid_token_authenticates_allauth_and_drf(self):
        user, meta = self.verified_user()
        self.bearer(meta["access_token"])
        response = self.client.get(SESSION_URL)
        self.assertEqual(response.status_code, 200)
        body = _body(response)
        self.assertTrue(body["meta"]["is_authenticated"])
        self.assertEqual(body["data"]["user"]["id"], user.id)
        # The DRF side: allauth's JWTTokenAuthentication resolves the
        # same token for the rest of the API.
        self.assertEqual(self.client.get("/captures/").status_code, 200)

    def test_garbage_token_is_401(self):
        self.verified_user()
        self.bearer("garbage.token.here")
        self.assertEqual(self.client.get(SESSION_URL).status_code, 401)
        self.assertEqual(self.client.get("/captures/").status_code, 401)

    def test_expired_token_is_401(self):
        _, meta = self.verified_user()
        access_token = meta["access_token"]
        header, payload_b64, _signature = access_token.split(".")
        payload = json.loads(base64.urlsafe_b64decode(
            payload_b64 + "=" * (-len(payload_b64) % 4)))
        payload["exp"] = payload["iat"] - 60
        # Re-sign with the same key allauth uses for HS256 (SECRET_KEY
        # fallback): valid signature, past expiry.
        forged = pyjwt.encode(payload, django_settings.SECRET_KEY,
                              algorithm="HS256")
        if isinstance(forged, bytes):  # PyJWT < 2
            forged = forged.decode("ascii")
        self.bearer(forged)
        self.assertEqual(self.client.get(SESSION_URL).status_code, 401)


class RefreshTokenTests(AllauthAuthBase):
    def _authenticated(self):
        user, meta = self.verified_user()
        self.client.credentials()  # drop headers; the cookie stays
        self.assertTrue(self.client.cookies.get(REFRESH_COOKIE).value)
        return user, meta

    def test_refresh_rotates_token_and_cookie(self):
        self._authenticated()
        old = self.client.cookies[REFRESH_COOKIE].value
        response = self.client.post(
            REFRESH, {"refresh_token": old}, format="json")
        self.assertEqual(response.status_code, 200)
        data = _body(response)["data"]
        self.assertIn("access_token", data)
        # The rotated refresh token left the body for the cookie.
        self.assertNotIn("refresh_token", data)
        new = response.cookies[REFRESH_COOKIE].value
        self.assertNotEqual(new, old)
        # The freshly minted access token works.
        self.bearer(data["access_token"])
        self.assertEqual(self.client.get(SESSION_URL).status_code, 200)

    def test_refresh_cookie_attributes(self):
        self._authenticated()
        old = self.client.cookies[REFRESH_COOKIE].value
        response = self.client.post(
            REFRESH, {"refresh_token": old}, format="json")
        cookie = response.cookies[REFRESH_COOKIE]
        self.assertEqual(cookie["path"],
                         django_settings.AUTH_REFRESH_COOKIE_PATH)
        self.assertTrue(cookie["httponly"])
        self.assertTrue(cookie["secure"])
        self.assertEqual(cookie["samesite"], "Lax")

    def test_refresh_falls_back_to_cookie(self):
        # A browser cannot read its own HttpOnly cookie to put in the
        # body; the endpoint accepts an empty body and the cookie.
        self._authenticated()
        response = self.client.post(REFRESH, {}, format="json")
        self.assertEqual(response.status_code, 200)
        data = _body(response)["data"]
        self.assertIn("access_token", data)
        self.assertNotIn("refresh_token", data)
        self.assertTrue(response.cookies[REFRESH_COOKIE].value)

    def test_stale_and_garbage_refresh_are_400(self):
        self._authenticated()
        old = self.client.cookies[REFRESH_COOKIE].value
        self.client.post(REFRESH, {"refresh_token": old}, format="json")
        # Rotation invalidated the old token.
        self.assertEqual(
            self.client.post(
                REFRESH, {"refresh_token": old}, format="json")
            .status_code, 400)
        self.client.cookies.clear()
        self.assertEqual(
            self.client.post(
                REFRESH, {"refresh_token": "garbage"}, format="json")
            .status_code, 400)
        self.assertEqual(
            self.client.post(REFRESH, {}, format="json").status_code, 400)

    def test_refresh_after_logout_is_400(self):
        _, meta = self.verified_user()
        self.client.credentials()
        refresh_token = self.client.cookies[REFRESH_COOKIE].value
        self.bearer(meta["access_token"])
        self.assertEqual(self.client.delete(SESSION_URL).status_code, 401)
        self.assertEqual(
            self.client.post(
                REFRESH, {"refresh_token": refresh_token}, format="json")
            .status_code, 400)  # the session behind it is gone


class LogoutTests(AllauthAuthBase):
    def test_logout_kills_tokens_and_cookie(self):
        _, meta = self.verified_user()
        self.bearer(meta["access_token"])
        refresh_before = self.client.cookies[REFRESH_COOKIE].value
        response = self.client.delete(SESSION_URL)
        self.assertEqual(response.status_code, 401)
        self.assertFalse(_body(response)["meta"]["is_authenticated"])
        cookie = response.cookies[REFRESH_COOKIE]
        self.assertEqual(cookie.value, "")
        self.assertEqual(int(cookie["max-age"]), 0)
        self.assertEqual(cookie["path"],
                         django_settings.AUTH_REFRESH_COOKIE_PATH)
        # Stateful validation: the access token dies immediately.
        self.assertEqual(self.client.get(SESSION_URL).status_code, 401)
        # ... and the refresh token no longer refreshes.
        self.client.cookies[REFRESH_COOKIE] = refresh_before
        self.assertEqual(
            self.client.post(
                REFRESH, {"refresh_token": refresh_before}, format="json")
            .status_code, 400)


class ConfigTests(AllauthAuthBase):
    def test_config(self):
        response = self.client.get(CONFIG_URL)
        self.assertEqual(response.status_code, 200)
        data = _body(response)["data"]
        self.assertEqual(data["account"]["login_methods"], ["email"])
        self.assertTrue(data["account"]["is_open_for_signup"])
        self.assertTrue(data["account"]["email_verification_by_code_enabled"])
        self.assertEqual(data["socialaccount"]["providers"], [])


class FakeSearchProvider:
    """In-test stand-in for the provider's generate_embedding: no
    pacing, no network. Returns one fixed vector per query and records
    the query texts it was asked to embed."""

    def __init__(self, vector):
        self.vector = vector
        self.query_calls: list[str] = []

    def generate_embedding(self, text):
        self.query_calls.append(text)
        return self.vector


def _vec(*values, dim=4):
    return list(values) + [0.0] * (dim - len(values))


LONG_TEXT = "word " * 100  # well past PREVIEW_CHARS


class SearchHelperTests(TestCase):
    """search_captures against real Postgres vectors (pgvector does the
    cosine math), with a fake provider for the query embedding."""

    def setUp(self):
        self.user = get_user_model().objects.create_user(
            "u", "u@example.com", "pw"
        )
        self.other = get_user_model().objects.create_user(
            "o", "o@example.com", "pw"
        )

        # Query vector is +x. Similarities are by construction:
        #   [1,0,0,0]   → 1.0
        #   [0.5,0.5,0,0] → 1/√2 ≈ 0.7071
        #   [0.3,0.4,0,0] → 0.6
        #   [0,1,0,0]   → 0.0

        self.capture_a = Capture.objects.create(user=self.user)
        CaptureContext.objects.create(
            user=self.user,
            capture_id=self.capture_a,
            text_context="truck page",
            summary_text="A page about red trucks",
        )
        for key, vector, text in (
            ("text:context:0", _vec(1.0), LONG_TEXT),
            ("text:context:1", _vec(0.5, 0.5), "a corner of the page"),
        ):
            CaptureEmbedding.objects.create(
                user=self.user,
                capture_id=self.capture_a,
                source_key=key,
                text=text,
                embedding=vector,
                embedding_model="gemini-embedding-2",
            )
        # A row without a vector never participates in scoring.
        CaptureEmbedding.objects.create(
            user=self.user,
            capture_id=self.capture_a,
            source_key="image:img-1:0",
            text="unembedded image",
            embedding=None,
            embedding_model=None,
        )

        self.capture_b = Capture.objects.create(user=self.user)
        CaptureContext.objects.create(
            user=self.user,
            capture_id=self.capture_b,
            text_context="engine page",
            summary_text=None,  # not generated yet
        )
        for key, vector, text in (
            ("text:context:0", _vec(0.3, 0.4), "engine details"),
            ("summary:global:0", _vec(0.0, 1.0), "engine summary"),
        ):
            CaptureEmbedding.objects.create(
                user=self.user,
                capture_id=self.capture_b,
                source_key=key,
                text=text,
                embedding=vector,
                embedding_model="gemini-embedding-2",
            )

        # Another user's capture, identical best vector: must never leak.
        other_capture = Capture.objects.create(user=self.other)
        CaptureEmbedding.objects.create(
            user=self.other,
            capture_id=other_capture,
            source_key="text:context:0",
            text="their page",
            embedding=_vec(1.0),
            embedding_model="gemini-embedding-2",
        )

    def _search(self, **kwargs):
        provider = FakeSearchProvider(_vec(1.0))
        return search_captures(
            self.user, "a red truck", provider=provider, **kwargs
        ), provider

    def test_ranks_captures_by_best_chunk(self):
        results, _ = self._search()
        self.assertEqual(
            [r["capture_id"] for r in results],
            [self.capture_a.capture_id, self.capture_b.capture_id],
        )
        self.assertEqual([r["rank"] for r in results], [1, 2])
        self.assertAlmostEqual(results[0]["score"], 1.0, places=6)
        self.assertAlmostEqual(results[1]["score"], 0.6, places=6)

    def test_each_capture_appears_once_with_all_chunks_best_first(self):
        results, _ = self._search()
        a, b = results
        self.assertEqual(
            [c["source_key"] for c in a["chunks"]],
            ["text:context:0", "text:context:1"],
        )
        self.assertAlmostEqual(a["chunks"][0]["score"], 1.0, places=6)
        self.assertAlmostEqual(a["chunks"][1]["score"], 0.707107, places=6)
        # The null-vector row never appears.
        self.assertNotIn("image:img-1:0", [c["source_key"] for c in a["chunks"]])
        self.assertEqual(
            [c["source_key"] for c in b["chunks"]],
            ["text:context:0", "summary:global:0"],
        )

    def test_returns_metadata(self):
        results, _ = self._search()
        a, b = results
        self.assertEqual(a["summary_text"], "A page about red trucks")
        self.assertIsNotNone(a["created_at"])
        self.assertIsNone(b["summary_text"])  # context without a summary

    def test_chunk_text_is_a_preview(self):
        results, _ = self._search()
        self.assertEqual(len(results[0]["chunks"][0]["text"]), PREVIEW_CHARS)

    def test_other_users_captures_are_excluded(self):
        results, _ = self._search()
        self.assertEqual(len(results), 2)
        self.assertTrue(
            all(r["capture_id"] in (self.capture_a.capture_id, self.capture_b.capture_id)
                for r in results)
        )

    def test_k_limits_captures(self):
        results, _ = self._search(k=1)
        self.assertEqual([r["capture_id"] for r in results], [self.capture_a.capture_id])

    def test_min_score_filters_on_best_chunk(self):
        # A's best is 1.0, B's best is 0.6 → only A survives a 0.8 floor.
        results, _ = self._search(min_score=0.8)
        self.assertEqual([r["capture_id"] for r in results], [self.capture_a.capture_id])
        # Both survive a 0.5 floor.
        results, _ = self._search(min_score=0.5)
        self.assertEqual(len(results), 2)

    def test_legacy_dimension_rows_are_skipped(self):
        # A 3072-dim row from before the 1536 switch: it must be skipped
        # (pgvector would error on a mixed-dimension distance op), not
        # crash the search.
        CaptureEmbedding.objects.create(
            user=self.user,
            capture_id=self.capture_b,
            source_key="text:context:legacy",
            text="legacy chunk",
            embedding=[0.5] * 3072,
            embedding_model="gemini-embedding-2",
        )
        results, _ = self._search()
        self.assertEqual(len(results), 2)
        self.assertNotIn(
            "text:context:legacy",
            [c["source_key"] for c in results[1]["chunks"]],
        )

    def test_query_is_embedded_once(self):
        _, provider = self._search()
        self.assertEqual(provider.query_calls, ["a red truck"])


class SearchApiTests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            "a", "a@example.com", "pw"
        )

    def test_requires_auth(self):
        response = self.client.get("/search/", {"q": "x"})
        self.assertEqual(response.status_code, 401)

    def test_missing_q_is_400(self):
        self.client.force_authenticate(self.user)
        response = self.client.get("/search/")
        self.assertEqual(response.status_code, 400)
        self.assertIn("q", str(response.data["detail"]))

    def test_blank_q_is_400(self):
        self.client.force_authenticate(self.user)
        response = self.client.get("/search/", {"q": "   "})
        self.assertEqual(response.status_code, 400)

    @patch("core.api.views.search_captures")
    def test_invalid_k_is_400(self, mock_search):
        self.client.force_authenticate(self.user)
        for bad_k in ("abc", "0", "-2"):
            response = self.client.get("/search/", {"q": "x", "k": bad_k})
            self.assertEqual(response.status_code, 400, bad_k)
        mock_search.assert_not_called()

    @patch("core.api.views.search_captures")
    def test_invalid_min_score_is_400(self, mock_search):
        self.client.force_authenticate(self.user)
        for bad in ("abc", "nan", "inf"):
            response = self.client.get("/search/", {"q": "x", "min_score": bad})
            self.assertEqual(response.status_code, 400, bad)
        mock_search.assert_not_called()

    @patch("core.api.views.search_captures")
    def test_success_shape(self, mock_search):
        capture_id = uuid.uuid4()
        mock_search.return_value = [
            {
                "capture_id": capture_id,
                "rank": 1,
                "score": 0.87,
                "summary_text": "a page about red trucks",
                "created_at": timezone.now(),
                "chunks": [
                    {
                        "source_key": "summary:global:0",
                        "score": 0.87,
                        "text": "This page describes a red truck…",
                    },
                    {
                        "source_key": "text:context:1",
                        "score": 0.4,
                        "text": "a corner of the page",
                    },
                ],
            }
        ]
        self.client.force_authenticate(self.user)
        response = self.client.get(
            "/search/", {"q": "red truck", "k": "3", "min_score": "0.5"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 1)
        hit = response.data[0]
        self.assertEqual(hit["capture_id"], str(capture_id))
        self.assertEqual(hit["rank"], 1)
        self.assertAlmostEqual(hit["score"], 0.87)
        self.assertEqual(hit["summary_text"], "a page about red trucks")
        self.assertEqual(hit["chunks"][0]["source_key"], "summary:global:0")
        # The vector never leaves the DB — not in the response either.
        self.assertNotIn("embedding", hit)
        mock_search.assert_called_once_with(
            self.user, "red truck", k=3, min_score=0.5
        )

    @patch("core.api.views.search_captures")
    def test_no_filters_by_default(self, mock_search):
        mock_search.return_value = []
        self.client.force_authenticate(self.user)
        response = self.client.get("/search/", {"q": "anything"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, [])
        mock_search.assert_called_once_with(self.user, "anything", k=None, min_score=None)


# ---------------------------------------------------------------------------
# Media storage: Supabase bucket, local-disk fallback, ingest, capture flow
# ---------------------------------------------------------------------------


SUPABASE_ENV = {
    "SUPABASE_URL": "https://proj.supabase.co",
    "SUPABASE_SERVICE_KEY": "service-key",
    "SUPABASE_BUCKET": "captures",
    "MEDIA_PUBLIC": True,
    "MEDIA_SIGNED_URL_TTL": 3600,
}


def _fake_get_response(content=b"x", status_code=200, content_type="image/jpeg"):
    """A fake `requests` response for core.storage.download_capped."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.headers = {"Content-Type": content_type}
    resp.iter_content = lambda chunk_size: iter([content])
    return resp


def _local_storage(tmp: str) -> FileSystemStorage:
    return FileSystemStorage(location=tmp)


def _isolated_media_root():
    """Context manager: the *default* Django storage resolves to a
    throwaway directory (and the lazy object is reset around it), so
    file-backed tests never touch the repository's media/ directory.

    The STORAGES override pins ``default`` to the local-disk backend
    *regardless of .env*: a checkout with SUPABASE_URL set would
    otherwise route every save in here to the live bucket (the helper's
    MEDIA_ROOT override is meaningless to SupabaseStorage)."""
    tmp = tempfile.mkdtemp(prefix="bm-media-")

    @contextlib.contextmanager
    def _ctx():
        from django.core.files import storage as _dj_storage
        from django.utils.functional import empty

        with override_settings(
            MEDIA_ROOT=tmp,
            STORAGES={
                "default": {
                    "BACKEND": "django.core.files.storage.FileSystemStorage"
                },
                "staticfiles": {
                    "BACKEND": (
                        "django.core.files.staticfiles.storage"
                        ".StaticFilesStorage"
                    )
                },
            },
        ):
            # Re-resolve the default storage against this MEDIA_ROOT: the
            # StorageHandler memoizes constructed backends, and the lazy
            # object only re-runs _setup() when _wrapped is the `empty`
            # sentinel (a `None` reset would just break it).
            _dj_storage.storages._storages.clear()
            _dj_storage.default_storage._wrapped = empty
            try:
                yield tmp
            finally:
                _dj_storage.storages._storages.clear()
                _dj_storage.default_storage._wrapped = empty
                shutil.rmtree(tmp, ignore_errors=True)

    return _ctx()


def _png_bytes() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (255, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()


def _png_data_uri() -> str:
    return "data:image/png;base64," + base64.b64encode(_png_bytes()).decode()


class StorageLayoutTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            "u", "u@example.com", "pw"
        )

    def test_media_object_path(self):
        self.assertEqual(
            media_object_path("cap1", "images", "i9", ".jpg"),
            "cap1/images/i9.jpg",
        )

    def test_screenshot_upload_to_prefixes_capture_id(self):
        capture = Capture(user=self.user)
        self.assertEqual(
            screenshot_upload_to(capture, "screenshot.png"),
            f"{capture.capture_id}/screenshot.png",
        )

    def test_is_external_url(self):
        self.assertTrue(is_external_url("https://example.com/a.jpg"))
        self.assertTrue(is_external_url("http://example.com/a.jpg"))
        self.assertFalse(is_external_url("cap1/images/i9.jpg"))
        self.assertFalse(is_external_url(""))
        self.assertFalse(is_external_url(None))

    def test_extension_for(self):
        self.assertEqual(extension_for("photo.JPG"), ".jpg")
        self.assertEqual(extension_for("a.jpg?v=1"), ".jpg")  # query string stripped
        self.assertEqual(extension_for(None, "video/mp4"), ".mp4")
        self.assertEqual(extension_for("noext", "image/jpeg"), ".jpg")
        self.assertEqual(extension_for("weird.xyz99999999", None), ".bin")
        self.assertEqual(extension_for(None, None), ".bin")


class FakeStorageAPI:
    """In-test stand-in for the Supabase bucket object API (storage3)."""

    def __init__(self):
        self.objects: dict[str, tuple[bytes, dict]] = {}
        self.removed: list[str] = []

    def upload(self, path, file, file_options=None):
        data = file.read() if hasattr(file, "read") else file
        self.objects[path] = (data, dict(file_options or {}))
        return {"path": path, "fullPath": f"bucket/{path}"}

    def exists(self, path):
        return path in self.objects

    def download(self, path, options=None, query_params=None):
        return self.objects[path][0]

    def get_public_url(self, path, options=None):
        return f"https://proj.supabase.co/storage/v1/object/public/bucket/{path}"

    def create_signed_url(self, path, expires_in, options=None):
        return {
            "signedURL": (
                f"https://proj.supabase.co/storage/v1/object/sign/{path}"
                f"?token=t{expires_in}"
            )
        }

    def remove(self, paths):
        self.removed.extend(paths)
        for path in paths:
            self.objects.pop(path, None)
        return []

    def list(self, path=None, options=None):
        prefix = f"{path}/" if path else ""
        return [
            {"name": name[len(prefix):]}
            for name in self.objects
            if name.startswith(prefix)
        ]


class FakeSupabaseClient:
    """The `supabase` client shape core.storage uses: .storage.from_()."""

    def __init__(self):
        self.api = FakeStorageAPI()
        holder = _StorageHolder(self.api)
        self.storage = holder


class _StorageHolder:
    def __init__(self, api):
        self._api = api

    def from_(self, bucket):
        return self._api


@override_settings(**SUPABASE_ENV)
class SupabaseStorageTests(TestCase):
    def setUp(self):
        self.fake_client = FakeSupabaseClient()
        self.storage = SupabaseStorage(client=self.fake_client)

    def test_requires_supabase_url(self):
        with override_settings(SUPABASE_URL=""):
            with self.assertRaises(ImproperlyConfigured):
                SupabaseStorage(client=self.fake_client)

    def test_save_uploads_with_content_type_and_upsert(self):
        self.storage.save("cap1/images/a.jpg", ContentFile(b"img-bytes"))
        data, options = self.fake_client.api.objects["cap1/images/a.jpg"]
        self.assertEqual(data, b"img-bytes")
        self.assertEqual(options["content-type"], "image/jpeg")
        self.assertEqual(options["upsert"], "true")

    def test_public_url(self):
        self.assertEqual(
            self.storage.url("cap1/screenshot.png"),
            "https://proj.supabase.co/storage/v1/object/public/bucket/"
            "cap1/screenshot.png",
        )

    @override_settings(MEDIA_PUBLIC=False, MEDIA_SIGNED_URL_TTL=123)
    def test_signed_url_when_not_public(self):
        # Constructed inside the override: public/ttl are read at init.
        storage = SupabaseStorage(client=self.fake_client)
        self.assertEqual(
            storage.url("cap1/screenshot.png"),
            "https://proj.supabase.co/storage/v1/object/sign/"
            "cap1/screenshot.png?token=t123",
        )

    def test_exists_delete_open(self):
        self.assertFalse(self.storage.exists("cap1/a.png"))
        self.storage.save("cap1/a.png", ContentFile(b"x"))
        self.assertTrue(self.storage.exists("cap1/a.png"))
        with self.storage.open("cap1/a.png") as fh:
            self.assertEqual(fh.read(), b"x")
        self.storage.delete("cap1/a.png")
        self.assertFalse(self.storage.exists("cap1/a.png"))
        self.assertEqual(self.fake_client.api.removed, ["cap1/a.png"])

    def test_list_prefix(self):
        self.storage.save("cap1/screenshot.png", ContentFile(b"s"))
        self.storage.save("cap1/images/a.jpg", ContentFile(b"a"))
        self.storage.save("other/x.png", ContentFile(b"x"))
        self.assertEqual(
            sorted(self.storage.list_prefix("cap1")),
            ["cap1/images/a.jpg", "cap1/screenshot.png"],
        )


class ResolveSourceTests(TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bm-media-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = patch(
            "core.storage.get_storage", return_value=_local_storage(self.tmp)
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_bucket_path_resolves_to_local_path_in_fallback(self):
        ref = resolve_source({"id": "i1", "url": "cap1/images/i1.jpg"})
        self.assertEqual(
            ref, os.path.join(self.tmp, "cap1/images/i1.jpg")
        )

    def test_external_url_passes_through(self):
        source = {"id": "i1", "url": "https://origin.example/a.jpg"}
        self.assertIs(resolve_source(source), source)

    def test_bare_string(self):
        self.assertEqual(
            resolve_source("cap1/videos/v1.mp4"),
            os.path.join(self.tmp, "cap1/videos/v1.mp4"),
        )
        self.assertEqual(
            resolve_source("https://origin.example/a.jpg"),
            "https://origin.example/a.jpg",
        )

    @override_settings(**SUPABASE_ENV)
    def test_bucket_path_resolves_to_bucket_url_in_supabase_mode(self):
        storage = SupabaseStorage(client=FakeSupabaseClient())
        ref = resolve_source({"id": "i1", "url": "cap1/images/i1.jpg"}, storage=storage)
        self.assertEqual(
            ref,
            "https://proj.supabase.co/storage/v1/object/public/bucket/"
            "cap1/images/i1.jpg",
        )


class MediaIngestTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            "u", "u@example.com", "pw"
        )
        self.tmp = tempfile.mkdtemp(prefix="bm-media-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        storage_patcher = patch(
            "core.storage.get_storage", return_value=_local_storage(self.tmp)
        )
        storage_patcher.start()
        self.addCleanup(storage_patcher.stop)
        get_patcher = patch("core.storage.requests.get")
        get_patcher.start()
        self.addCleanup(get_patcher.stop)
        self.fake_get = get_patcher.start()

    def _capture(self):
        return Capture.objects.create(
            user=self.user,
            image_sources=[{"id": "i1", "url": "https://origin.example/a.jpg"}],
            video_sources=[{"id": "v1", "url": "https://origin.example/big.mp4"}],
        )

    def test_stores_external_sources_and_rewrites_entries(self):
        self.fake_get.side_effect = lambda url, **kw: _fake_get_response(b"media")
        capture = self._capture()

        result = ingest_capture_media(capture)

        self.assertIs(result, capture)
        capture.refresh_from_db()
        img, vid = capture.image_sources[0], capture.video_sources[0]
        self.assertEqual(img["url"], f"{capture.capture_id}/images/i1.jpg")
        self.assertEqual(img["original_url"], "https://origin.example/a.jpg")
        self.assertEqual(vid["url"], f"{capture.capture_id}/videos/v1.mp4")
        self.assertTrue(os.path.exists(os.path.join(self.tmp, img["url"])))
        self.assertEqual(self.fake_get.call_count, 2)

    def test_second_run_is_noop(self):
        self.fake_get.side_effect = lambda url, **kw: _fake_get_response(b"x")
        capture = self._capture()

        ingest_capture_media(capture)
        self.fake_get.reset_mock()
        ingest_capture_media(capture)

        self.fake_get.assert_not_called()  # nothing re-downloaded

    @override_settings(MEDIA_MAX_FILE_BYTES=10)
    def test_oversized_source_is_kept_link_based(self):
        self.fake_get.side_effect = lambda url, **kw: _fake_get_response(b"x" * 100)
        capture = self._capture()

        ingest_capture_media(capture)  # must not raise

        capture.refresh_from_db()
        entry = capture.image_sources[0]
        self.assertEqual(entry["url"], "https://origin.example/a.jpg")
        # Assessed (original_url set) so a later run does not re-download.
        self.assertEqual(entry["original_url"], "https://origin.example/a.jpg")
        self.assertFalse(os.path.exists(os.path.join(self.tmp, entry["url"])))

    def test_download_failures_mark_the_entries_and_do_not_raise(self):
        self.fake_get.side_effect = lambda url, **kw: _fake_get_response(
            status_code=403
        )
        capture = self._capture()

        result = ingest_capture_media(capture)  # must not raise

        self.assertIs(result, capture)
        capture.refresh_from_db()
        for entry in capture.image_sources + capture.video_sources:
            self.assertEqual(entry["status"], "download_failed")
            self.assertEqual(entry["download_error"], "HTTP 403")
            # Still external, and NOT assessed: a retry re-attempts it.
            self.assertTrue(entry["url"].startswith("https://"))
            self.assertNotIn("original_url", entry)
        self.assertEqual(
            media_failure_summary(capture),
            "media: 2 item(s) failed: "
            "https://origin.example/a.jpg (HTTP 403); "
            "https://origin.example/big.mp4 (HTTP 403)",
        )

    def test_failed_item_is_reattempted_on_a_later_run(self):
        self.fake_get.side_effect = lambda url, **kw: _fake_get_response(
            status_code=403
        )
        capture = self._capture()

        ingest_capture_media(capture)
        self.fake_get.reset_mock()
        ingest_capture_media(capture)  # a dead link may come back: re-attempt

        self.assertEqual(self.fake_get.call_count, 2)

    def test_failed_item_recovers_when_the_link_comes_back(self):
        calls = {"n": 0}

        def fake_get(url, **kw):
            calls["n"] += 1
            if calls["n"] == 1:
                return _fake_get_response(status_code=404)
            return _fake_get_response(b"img")

        self.fake_get.side_effect = fake_get
        capture = Capture.objects.create(
            user=self.user,
            image_sources=[{"id": "i1", "url": "https://origin.example/a.jpg"}],
        )

        ingest_capture_media(capture)
        capture.refresh_from_db()
        self.assertEqual(capture.image_sources[0]["status"], "download_failed")

        ingest_capture_media(capture)
        capture.refresh_from_db()
        entry = capture.image_sources[0]
        self.assertEqual(entry["status"], "downloaded")
        # The object name is built from the entry's id + the URL's extension.
        self.assertEqual(entry["url"], f"{capture.capture_id}/images/i1.jpg")
        self.assertEqual(entry["original_url"], "https://origin.example/a.jpg")

    def test_storage_upload_failure_degrades_per_item(self):
        self.fake_get.side_effect = lambda url, **kw: _fake_get_response(b"img")
        with patch(
            "core.storage.save_bytes", side_effect=OSError("disk full")
        ):
            capture = self._capture()

            result = ingest_capture_media(capture)  # must not raise

        self.assertIs(result, capture)
        capture.refresh_from_db()
        for entry in capture.image_sources + capture.video_sources:
            self.assertEqual(entry["status"], "download_failed")
            self.assertEqual(entry["download_error"], "storage upload failed: OSError")
            self.assertTrue(entry["url"].startswith("https://"))
            self.assertNotIn("original_url", entry)

    def test_mixed_outcomes_keep_successes_and_mark_failures(self):
        def fake_get(url, **kw):
            if url.endswith(".jpg"):
                return _fake_get_response(b"img")
            return _fake_get_response(status_code=404)

        self.fake_get.side_effect = fake_get
        capture = self._capture()

        ingest_capture_media(capture)  # must not raise

        capture.refresh_from_db()
        img, vid = capture.image_sources[0], capture.video_sources[0]
        # The successful download was stored (name from the entry's id) ...
        self.assertEqual(img["status"], "downloaded")
        self.assertEqual(img["url"], f"{capture.capture_id}/images/i1.jpg")
        self.assertEqual(img["original_url"], "https://origin.example/a.jpg")
        # ... while the failure stays external for the retry, marked.
        self.assertEqual(vid["status"], "download_failed")
        self.assertEqual(vid["url"], "https://origin.example/big.mp4")
        self.assertNotIn("original_url", vid)
        self.assertEqual(
            media_failure_summary(capture),
            "media: 1 item(s) failed: https://origin.example/big.mp4 (HTTP 404)",
        )

    def test_noop_when_nothing_external(self):
        capture = self._capture()
        # Everything already stored / assessed: nothing for ingest to do.
        capture.image_sources[0]["url"] = f"{capture.capture_id}/images/i1.jpg"
        capture.image_sources[0]["original_url"] = "assessed"
        capture.video_sources[0]["url"] = f"{capture.capture_id}/videos/v1.mp4"
        capture.video_sources[0]["original_url"] = "assessed"
        updated_before = Capture.objects.get(pk=capture.pk).updated_at

        ingest_capture_media(capture)

        self.fake_get.assert_not_called()
        # No save at all: updated_at untouched.
        self.assertEqual(Capture.objects.get(pk=capture.pk).updated_at, updated_before)

    def _assessed_entry(self, url, status, **extra):
        entry = {"id": "i1", "url": url, "original_url": "assessed", "status": status}
        entry.update(extra)
        return entry

    def test_failure_summary_is_none_when_all_is_well(self):
        capture = self._capture()
        capture.image_sources[0] = self._assessed_entry(
            f"{capture.capture_id}/images/i1.jpg", "downloaded"
        )
        capture.video_sources[0] = self._assessed_entry(
            "https://origin.example/big.mp4", "skipped"
        )
        self.assertIsNone(media_failure_summary(capture))

    def test_failure_summary_names_download_and_processing_failures(self):
        capture = self._capture()
        # A stored item whose provider call failed (processing_error) ...
        capture.image_sources[0] = self._assessed_entry(
            f"{capture.capture_id}/images/i1.jpg",
            "downloaded",
            original_url="https://origin.example/a.jpg",
            processing_error="ClientError",
        )
        # ... and a link that could not be downloaded at all.
        capture.video_sources[0] = {
            "id": "v1",
            "url": "https://origin.example/big.mp4",
            "status": "download_failed",
            "download_error": "HTTP 404",
        }
        self.assertEqual(
            media_failure_summary(capture),
            "media: 2 item(s) failed: "
            "https://origin.example/a.jpg (processing failed: ClientError); "
            "https://origin.example/big.mp4 (HTTP 404)",
        )

    def test_failure_summary_never_leaks_internal_storage_paths(self):
        capture = self._capture()
        # A stored item with no client-reported URL (a multipart upload):
        # the label must fall back to the id, not the bucket path.
        capture.image_sources[0] = self._assessed_entry(
            f"{capture.capture_id}/images/i1.jpg",
            "downloaded",
            original_url=None,
            processing_error="ClientError",
        )
        note = media_failure_summary(capture)
        self.assertIsNotNone(note)
        self.assertIn("i1 (processing failed: ClientError)", note)
        self.assertNotIn(str(capture.capture_id), note)

    def test_failure_summary_truncates_long_failure_lists(self):
        capture = self._capture()
        capture.image_sources = [
            {
                "id": f"i{n}",
                "url": f"https://origin.example/x{n}.jpg",
                "status": "download_failed",
                "download_error": "HTTP 404",
            }
            for n in range(7)
        ]
        note = media_failure_summary(capture)
        self.assertIn("media: 7 item(s) failed:", note)
        self.assertIn("(+2 more)", note)
        self.assertNotIn("x6.", note)  # beyond the first five
        self.assertLessEqual(len(note), 500)


@override_settings(**SUPABASE_ENV)
class MediaIngestSupabaseModeTests(TestCase):
    """Ingest against the real SupabaseStorage (fake client underneath)."""

    def setUp(self):
        self.user = get_user_model().objects.create_user(
            "u", "u@example.com", "pw"
        )
        self.fake_client = FakeSupabaseClient()
        storage_patcher = patch(
            "core.storage.get_storage",
            return_value=SupabaseStorage(client=self.fake_client),
        )
        storage_patcher.start()
        self.addCleanup(storage_patcher.stop)
        get_patcher = patch("core.storage.requests.get")
        get_patcher.start()
        self.addCleanup(get_patcher.stop)
        self.fake_get = get_patcher.start()

    def test_ingest_uploads_to_the_bucket(self):
        self.fake_get.side_effect = lambda url, **kw: _fake_get_response(b"img")
        capture = Capture.objects.create(
            user=self.user,
            image_sources=[{"id": "i1", "url": "https://origin.example/a.jpg"}],
        )

        ingest_capture_media(capture)

        name = f"{capture.capture_id}/images/i1.jpg"
        self.assertEqual(self.fake_client.api.objects[name][0], b"img")
        capture.refresh_from_db()
        self.assertEqual(capture.image_sources[0]["url"], name)
        self.assertEqual(capture.image_sources[0]["status"], "downloaded")

    def test_bucket_upload_failure_degrades_per_item(self):
        self.fake_get.side_effect = lambda url, **kw: _fake_get_response(b"img")

        def fail_upload(path, file, file_options=None):
            raise RuntimeError("bucket is down")

        self.fake_client.api.upload = fail_upload
        capture = Capture.objects.create(
            user=self.user,
            image_sources=[{"id": "i1", "url": "https://origin.example/a.jpg"}],
        )

        ingest_capture_media(capture)  # must not raise

        capture.refresh_from_db()
        entry = capture.image_sources[0]
        self.assertEqual(entry["status"], "download_failed")
        self.assertEqual(
            entry["download_error"], "storage upload failed: RuntimeError"
        )
        # Still external, not assessed: a later run re-attempts it.
        self.assertEqual(entry["url"], "https://origin.example/a.jpg")
        self.assertNotIn("original_url", entry)


class CaptureMediaApiTests(APITestCase):
    """POST /captures/ with the extended (multipart) media contract."""

    def setUp(self):
        self.user_a = get_user_model().objects.create_user(
            "a", "a@example.com", "pw"
        )
        ctx = _isolated_media_root()
        self.tmp_root = ctx.__enter__()
        self.addCleanup(ctx.__exit__, None, None, None)
        patcher = patch("core.pipeline.async_task")
        patcher.start()
        self.addCleanup(patcher.stop)

    def _capture_from_response(self, response) -> Capture:
        return Capture.objects.get(
            capture_id=uuid.UUID(response.data["capture_id"])
        )

    def test_json_only_client_contract_unchanged(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {
                "text": ["some text"],
                "media": {
                    "images": [{"url": "https://origin.example/a.jpg"}],
                    "videos": [{"url": "https://origin.example/v.mp4"}],
                    "audios": [],
                },
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        capture = self._capture_from_response(response)
        # Exactly today's shape: id + external url, no original_url key.
        self.assertEqual(set(capture.image_sources[0].keys()), {"id", "url"})
        self.assertEqual(
            capture.image_sources[0]["url"], "https://origin.example/a.jpg"
        )
        self.assertEqual(
            capture.video_sources[0]["url"], "https://origin.example/v.mp4"
        )
        # Django 5.2 wraps an unset FileField in a (falsy) FieldFile rather
        # than leaving it None — assert falsiness, not None.
        self.assertFalse(capture.screenshot)
        # The source lists never reach the client (as before).
        self.assertNotIn("image_sources", response.data)

    def test_multipart_file_items_are_stored_at_creation(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {
                "text": "some text",
                "media": json.dumps(
                    {
                        "images": [
                            {"url": "https://origin.example/a.jpg"},
                            {"url": "https://origin.example/b.jpg"},
                        ],
                        "videos": [],
                        "audios": [],
                    }
                ),
                "file:images:0": SimpleUploadedFile(
                    "a.jpg", b"image-bytes", content_type="image/jpeg"
                ),
            },
            format="multipart",
        )
        self.assertEqual(response.status_code, 201, response.data)
        capture = self._capture_from_response(response)
        stored, link = capture.image_sources

        self.assertTrue(stored["url"].startswith(f"{capture.capture_id}/images/"))
        self.assertTrue(stored["url"].endswith(".jpg"))
        self.assertEqual(stored["original_url"], "https://origin.example/a.jpg")
        self.assertTrue(
            os.path.exists(os.path.join(self.tmp_root, stored["url"]))
        )
        # The item with no paired file part stays exactly as today.
        self.assertEqual(link["url"], "https://origin.example/b.jpg")
        self.assertNotIn("original_url", link)

    def test_file_over_per_file_cap_is_400(self):
        self.client.force_authenticate(self.user_a)
        with override_settings(MEDIA_MAX_FILE_BYTES=10):
            response = self.client.post(
                "/captures/",
                {
                    "media": json.dumps(
                        {"images": [{"url": "https://o/a.jpg"}]}
                    ),
                    "file:images:0": SimpleUploadedFile(
                        "a.jpg", b"x" * 100, content_type="image/jpeg"
                    ),
                },
                format="multipart",
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Capture.objects.count(), 0)
        self.assertEqual(os.listdir(self.tmp_root), [])  # nothing stored

    def test_per_capture_total_cap_is_400(self):
        self.client.force_authenticate(self.user_a)
        with override_settings(
            MEDIA_MAX_FILE_BYTES=10_000, MEDIA_MAX_TOTAL_PER_CAPTURE=150
        ):
            response = self.client.post(
                "/captures/",
                {
                    "media": json.dumps(
                        {"images": [{"url": "https://o/a.jpg"},
                                    {"url": "https://o/b.jpg"}]}
                    ),
                    "file:images:0": SimpleUploadedFile(
                        "a.jpg", b"x" * 100, content_type="image/jpeg"
                    ),
                    "file:images:1": SimpleUploadedFile(
                        "b.jpg", b"y" * 100, content_type="image/jpeg"
                    ),
                },
                format="multipart",
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Capture.objects.count(), 0)

    def test_screenshot_is_uploaded_at_creation(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {"text": "some text", "image": _png_data_uri()},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        capture = self._capture_from_response(response)
        self.assertTrue(capture.screenshot)
        self.assertTrue(
            os.path.exists(
                os.path.join(self.tmp_root, capture.screenshot.name)
            )
        )
        # The client gets a usable URL for the screenshot.
        self.assertTrue(response.data["screenshot"])

    def test_multipart_data_url_string_still_works(self):
        """Regression: the data-URL carrier (here as a multipart form
        field, its historical bridge shape) is unchanged by the part."""
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {"text": "some text", "image": _png_data_uri()},
            format="multipart",
        )
        self.assertEqual(response.status_code, 201, response.data)
        capture = self._capture_from_response(response)
        self.assertTrue(capture.screenshot)
        self.assertTrue(
            capture.screenshot.name.endswith("screenshot.png")
        )
        self.assertTrue(response.data["screenshot"])

    def test_screenshot_file_part_is_stored_at_creation(self):
        self.client.force_authenticate(self.user_a)
        png = _png_bytes()
        response = self.client.post(
            "/captures/",
            {
                "text": "some text",
                # No extension in the name: the stored extension comes
                # from the content type.
                "file:image:0": SimpleUploadedFile(
                    "screenshot", png, content_type="image/png"
                ),
            },
            format="multipart",
        )
        self.assertEqual(response.status_code, 201, response.data)
        capture = self._capture_from_response(response)
        self.assertTrue(capture.screenshot)
        self.assertEqual(
            capture.screenshot.name, f"{capture.capture_id}/screenshot.png"
        )
        with open(
            os.path.join(self.tmp_root, capture.screenshot.name), "rb"
        ) as fh:
            self.assertEqual(fh.read(), png)
        # The client gets a usable URL for the screenshot.
        self.assertTrue(response.data["screenshot"])

    def test_screenshot_part_generic_content_type_uses_filename(self):
        """A client that cannot supply a content type (octet-stream) is
        judged by the filename: a .jpg name is still a screenshot."""
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {
                "file:image:0": SimpleUploadedFile(
                    "screenshot.jpg", b"jpeg-bytes",
                    content_type="application/octet-stream",
                ),
            },
            format="multipart",
        )
        self.assertEqual(response.status_code, 201, response.data)
        capture = self._capture_from_response(response)
        self.assertEqual(
            capture.screenshot.name, f"{capture.capture_id}/screenshot.jpg"
        )

    def test_screenshot_file_part_over_per_file_cap_is_400(self):
        self.client.force_authenticate(self.user_a)
        with override_settings(MEDIA_MAX_FILE_BYTES=10):
            response = self.client.post(
                "/captures/",
                {
                    "file:image:0": SimpleUploadedFile(
                        "screenshot", b"x" * 100, content_type="image/png"
                    ),
                },
                format="multipart",
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Capture.objects.count(), 0)
        self.assertEqual(os.listdir(self.tmp_root), [])  # nothing stored

    def test_screenshot_part_counts_toward_the_total_cap(self):
        self.client.force_authenticate(self.user_a)
        with override_settings(
            MEDIA_MAX_FILE_BYTES=10_000, MEDIA_MAX_TOTAL_PER_CAPTURE=150
        ):
            response = self.client.post(
                "/captures/",
                {
                    "media": json.dumps(
                        {"images": [{"url": "https://o/a.jpg"}]}
                    ),
                    "file:images:0": SimpleUploadedFile(
                        "a.jpg", b"x" * 100, content_type="image/jpeg"
                    ),
                    "file:image:0": SimpleUploadedFile(
                        "screenshot", b"y" * 100, content_type="image/png"
                    ),
                },
                format="multipart",
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Capture.objects.count(), 0)
        self.assertEqual(os.listdir(self.tmp_root), [])  # nothing stored

    def test_screenshot_file_part_invalid_type_is_400(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/",
            {
                "file:image:0": SimpleUploadedFile(
                    "report.pdf", b"not-an-image",
                    content_type="application/pdf",
                ),
            },
            format="multipart",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("image", response.data)
        self.assertEqual(Capture.objects.count(), 0)
        self.assertEqual(os.listdir(self.tmp_root), [])  # nothing stored

    def test_file_part_wins_over_data_url_string(self):
        """Both carriers present: the file part is the screenshot, the
        string is not consulted."""
        self.client.force_authenticate(self.user_a)
        part_bytes = b"part-bytes"
        response = self.client.post(
            "/captures/",
            {
                "image": _png_data_uri(),
                "file:image:0": SimpleUploadedFile(
                    "screenshot", part_bytes, content_type="image/png"
                ),
            },
            format="multipart",
        )
        self.assertEqual(response.status_code, 201, response.data)
        capture = self._capture_from_response(response)
        with open(
            os.path.join(self.tmp_root, capture.screenshot.name), "rb"
        ) as fh:
            self.assertEqual(fh.read(), part_bytes)

    def test_multipart_media_field_must_be_json(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            "/captures/", {"media": "not-json"}, format="multipart"
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Capture.objects.count(), 0)


class MediaFakeProvider(FakeProvider):
    """FakeProvider plus the media description calls the context phase
    runs, recording the exact reference each call received.

    ``fail_on`` lists source URLs (the entry's ``url``) whose provider
    call should raise — the stand-in for a file Gemini cannot read, or
    a link whose origin is gone for good.
    """

    def __init__(self, fail_on=(), **kwargs):
        super().__init__(**kwargs)
        self.image_calls: list = []
        self.video_calls: list = []
        self.audio_calls: list = []
        self.fail_on = {self._as_url(u) for u in fail_on}

    @staticmethod
    def _as_url(source):
        return source.get("url") if isinstance(source, dict) else source

    def _maybe_fail(self, source):
        if self._as_url(source) in self.fail_on:
            raise RuntimeError(
                f"simulated media failure for {self._as_url(source)}"
            )

    def describe_image(self, source):
        self.image_calls.append(source)
        self._maybe_fail(source)
        return f"image of {source}"

    def describe_video(self, source):
        self.video_calls.append(source)
        self._maybe_fail(source)
        return f"video of {source}"

    def transcribe_audio(self, source):
        self.audio_calls.append(source)
        self._maybe_fail(source)
        return f"audio of {source}"


class PipelineMediaPhaseTests(TestCase):
    """The worker: claim -> processing_media -> context -> embeddings."""

    def setUp(self):
        self.user = get_user_model().objects.create_user(
            "u", "u@example.com", "pw"
        )
        self.tmp = tempfile.mkdtemp(prefix="bm-media-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        storage_patcher = patch(
            "core.storage.get_storage", return_value=_local_storage(self.tmp)
        )
        get_patcher = patch("core.storage.requests.get")
        provider_patcher = patch("core.pipeline.GeminiProvider")
        for patcher in (storage_patcher, get_patcher, provider_patcher):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.fake_get = get_patcher.start()
        self.provider_cls = provider_patcher.start()

    def _media_capture(self):
        return Capture.objects.create(
            user=self.user,
            image_sources=[{"id": "i1", "url": "https://origin.example/a.jpg"}],
            text_sources=["an article about red trucks"],
        )

    def test_process_capture_ingests_then_reaches_ready(self):
        capture = self._media_capture()
        self.fake_get.side_effect = lambda url, **kw: _fake_get_response(b"img")
        fake = MediaFakeProvider()
        self.provider_cls.return_value = fake

        process_capture(str(capture.capture_id))

        capture.refresh_from_db()
        self.assertEqual(capture.status, Capture.Status.READY)
        self.assertIsNone(capture.error_note)
        entry = capture.image_sources[0]
        self.assertEqual(entry["url"], f"{capture.capture_id}/images/i1.jpg")
        # The provider fetched the stored object, not the origin link.
        self.assertEqual(
            fake.image_calls, [os.path.join(self.tmp, entry["url"])]
        )
        self.assertTrue(os.path.exists(os.path.join(self.tmp, entry["url"])))

    def test_all_failed_media_fails_the_capture_with_a_summary(self):
        # A media-only capture whose items die at BOTH stages (the app
        # cannot download them and the origin is gone for the provider
        # too): nothing usable remains, so the run fails — with the
        # failure summary naming every item, not a stack trace.
        capture = Capture.objects.create(
            user=self.user,
            image_sources=[
                {"id": "i1", "url": "https://origin.example/a.jpg"},
                {"id": "i2", "url": "https://origin.example/b.png"},
            ],
        )
        self.fake_get.side_effect = lambda url, **kw: _fake_get_response(
            status_code=403
        )
        self.provider_cls.return_value = MediaFakeProvider(
            fail_on={"https://origin.example/a.jpg", "https://origin.example/b.png"}
        )

        with self.assertRaises(NoUsableContentError):
            process_capture(str(capture.capture_id))

        capture.refresh_from_db()
        self.assertEqual(capture.status, Capture.Status.FAILED)
        self.assertIn("media: 2 item(s) failed", capture.error_note)
        self.assertIn("a.jpg", capture.error_note)
        self.assertIn("b.png", capture.error_note)
        self.assertFalse(
            CaptureContext.objects.filter(capture_id=capture).exists()
        )

    def test_one_dead_media_degrades_the_capture_to_ready(self):
        # One of two images is dead at both stages; the other (plus the
        # text) survives. The capture completes `ready` with a note that
        # names only the lost item — it does not fail.
        capture = Capture.objects.create(
            user=self.user,
            text_sources=["an article about red trucks"],
            image_sources=[
                {"id": "i1", "url": "https://origin.example/a.jpg"},
                {"id": "i2", "url": "https://origin.example/b.png"},
            ],
        )

        def fake_get(url, **kw):
            if url.endswith("b.png"):
                return _fake_get_response(status_code=404)
            return _fake_get_response(b"img")

        self.fake_get.side_effect = fake_get
        self.provider_cls.return_value = MediaFakeProvider(
            fail_on={"https://origin.example/b.png"}
        )

        process_capture(str(capture.capture_id))  # must not raise

        capture.refresh_from_db()
        self.assertEqual(capture.status, Capture.Status.READY)
        self.assertIsNotNone(capture.error_note)
        self.assertIn("b.png", capture.error_note)
        self.assertNotIn("a.jpg", capture.error_note)
        self.assertNotIn("trucks", capture.error_note)

        context = CaptureContext.objects.get(capture_id=capture)
        by_id = {item["id"]: item for item in context.image_context}
        # The survivor was described from the stored copy ...
        self.assertTrue(
            by_id["i1"]["context"].startswith("image of")
        )
        self.assertNotIn("status", by_id["i1"])
        # ... the dead one is a failure marker with an empty context.
        self.assertEqual(by_id["i2"]["status"], "download_failed")
        self.assertEqual(by_id["i2"]["context"], "")
        # The summary describes what is left ...
        self.assertEqual(context.summary_text, "A unified summary.")
        self.assertNotIn("b.png", context.summary_text or "")
        # ... and embeddings were built for the surviving content.
        self.assertTrue(
            CaptureEmbedding.objects.filter(capture_id=capture).exists()
        )

    def test_dead_download_but_reachable_origin_still_describes(self):
        # The app's own download 403s, but the provider's origin fetch
        # (its documented fallback for link-based sources) succeeds: the
        # item degrades for storage, yet its content is captured and the
        # note names the storage-side failure only.
        capture = Capture.objects.create(
            user=self.user,
            text_sources=["an article about red trucks"],
            image_sources=[{"id": "i1", "url": "https://origin.example/a.jpg"}],
        )
        self.fake_get.side_effect = lambda url, **kw: _fake_get_response(
            status_code=403
        )
        self.provider_cls.return_value = MediaFakeProvider()

        process_capture(str(capture.capture_id))

        capture.refresh_from_db()
        self.assertEqual(capture.status, Capture.Status.READY)
        self.assertIsNotNone(capture.error_note)
        self.assertIn("a.jpg", capture.error_note)
        entry = capture.image_sources[0]
        self.assertEqual(entry["status"], "download_failed")
        self.assertNotIn("processing_error", entry)  # the attempt succeeded
        context = CaptureContext.objects.get(capture_id=capture)
        self.assertEqual(len(context.image_context), 1)
        self.assertTrue(context.image_context[0]["context"].startswith("image of"))

    def test_stale_processing_media_is_reclaimed_and_finished(self):
        capture = self._media_capture()
        capture.status = Capture.Status.PROCESSING_MEDIA
        capture.save()
        Capture.objects.filter(pk=capture.pk).update(
            updated_at=timezone.now() - _stale_delta()
        )
        self.fake_get.side_effect = lambda url, **kw: _fake_get_response(b"img")
        self.provider_cls.return_value = MediaFakeProvider()

        process_capture(str(capture.capture_id))

        capture.refresh_from_db()
        self.assertEqual(capture.status, Capture.Status.READY)

    def test_fresh_processing_media_not_stolen(self):
        capture = self._media_capture()
        capture.status = Capture.Status.PROCESSING_MEDIA
        capture.save()

        self.provider_cls.return_value = MediaFakeProvider()
        process_capture(str(capture.capture_id))

        self.assertEqual(self.fake_get.call_count, 0)  # no work ran at all
        self.assertFalse(
            CaptureContext.objects.filter(capture_id=capture).exists()
        )
        capture.refresh_from_db()
        self.assertEqual(capture.status, Capture.Status.PROCESSING_MEDIA)


class ContextPhaseDegradationTests(TestCase):
    """extract_contexts: failed media items degrade per item."""

    def setUp(self):
        self.user = get_user_model().objects.create_user(
            "u", "u@example.com", "pw"
        )
        self.tmp = tempfile.mkdtemp(prefix="bm-media-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        storage_patcher = patch(
            "core.storage.get_storage", return_value=_local_storage(self.tmp)
        )
        get_patcher = patch("core.storage.requests.get")
        for patcher in (storage_patcher, get_patcher):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.fake_get = get_patcher.start()

    def test_download_failed_item_yields_a_marker_item(self):
        # An item a previous run already failed to download (external
        # URL, not assessed); this run's download fails again and the
        # provider's origin attempt dies too. Text keeps the capture
        # alive.
        capture = Capture.objects.create(
            user=self.user,
            text_sources=["an article about red trucks"],
            image_sources=[
                {
                    "id": "i1",
                    "url": "https://origin.example/a.jpg",
                    "status": "download_failed",
                    "download_error": "HTTP 404",
                }
            ],
        )
        self.fake_get.side_effect = lambda url, **kw: _fake_get_response(
            status_code=404
        )
        provider = MediaFakeProvider(fail_on={"https://origin.example/a.jpg"})

        text, image, video, audio, summary = extract_contexts(capture, provider)

        self.assertEqual(text, "summarized: an article about red trucks")
        self.assertEqual(
            image,
            [{"id": "i1", "context": "", "status": "download_failed"}],
        )
        self.assertEqual(summary, "A unified summary.")
        # The failure reason was persisted on the source entry ...
        capture.refresh_from_db()
        self.assertEqual(
            capture.image_sources[0]["processing_error"], "RuntimeError"
        )
        # ... and the summary of failures is available for error_note.
        self.assertIn("a.jpg", media_failure_summary(capture))

    def test_stale_processing_error_is_cleared_on_success(self):
        # A stored item a previous run failed to PROCESS. The retry
        # succeeds: the reason must not linger (or a later error_note
        # would name a healthy item).
        capture = Capture.objects.create(
            user=self.user,
            text_sources=["an article about red trucks"],
        )
        name = f"{capture.capture_id}/images/i1.jpg"
        os.makedirs(os.path.join(self.tmp, os.path.dirname(name)), exist_ok=True)
        with open(os.path.join(self.tmp, name), "wb") as fh:
            fh.write(b"img-bytes")
        capture.image_sources = [
            {
                "id": "i1",
                "url": name,
                "original_url": "https://origin.example/a.jpg",
                "status": "downloaded",
                "processing_error": "ClientError",
            }
        ]
        capture.save()
        provider = MediaFakeProvider()

        text, image, *_ = extract_contexts(capture, provider)

        self.assertNotIn("status", image[0])
        self.assertTrue(image[0]["context"].startswith("image of"))
        capture.refresh_from_db()
        self.assertNotIn("processing_error", capture.image_sources[0])
        self.assertIsNone(media_failure_summary(capture))

    def test_skipped_oversized_item_still_processes_via_origin(self):
        # Kept link-based (over the size cap): the provider fetches from
        # the origin and the item is a normal survivor, no failure marks.
        capture = Capture.objects.create(
            user=self.user,
            text_sources=["an article about red trucks"],
            image_sources=[
                {
                    "id": "i1",
                    "url": "https://origin.example/big.jpg",
                    "original_url": "https://origin.example/big.jpg",
                    "status": "skipped",
                }
            ],
        )
        self.fake_get.side_effect = lambda url, **kw: _fake_get_response(b"img")
        provider = MediaFakeProvider()

        text, image, *_ = extract_contexts(capture, provider)

        self.assertNotIn("status", image[0])
        self.assertTrue(image[0]["context"].startswith("image of"))
        self.assertIsNone(media_failure_summary(capture))

    def test_all_failed_media_only_raises_no_usable_content(self):
        capture = Capture.objects.create(
            user=self.user,
            image_sources=[
                {
                    "id": "i1",
                    "url": "https://origin.example/a.jpg",
                    "status": "download_failed",
                    "download_error": "HTTP 404",
                },
                {
                    "id": "i2",
                    "url": "https://origin.example/b.png",
                    "status": "download_failed",
                    "download_error": "HTTP 404",
                },
            ],
        )
        self.fake_get.side_effect = lambda url, **kw: _fake_get_response(
            status_code=404
        )
        provider = MediaFakeProvider(
            fail_on={"https://origin.example/a.jpg", "https://origin.example/b.png"}
        )

        with self.assertRaises(NoUsableContentError):
            extract_contexts(capture, provider)

    def test_undegraded_empty_capture_still_returns(self):
        # No sources declared at all: nothing "failed", so the historical
        # behavior stands — empty contexts, no raise (the manual endpoint
        # keeps returning 201 with an empty row).
        capture = Capture.objects.create(user=self.user)
        provider = MediaFakeProvider()

        text, image, video, audio, summary = extract_contexts(capture, provider)

        self.assertEqual((text, image, video, audio, summary), ("", [], [], [], ""))

    def test_screenshot_provider_failure_yields_a_marker(self):
        capture = Capture.objects.create(
            user=self.user,
            text_sources=["an article about red trucks"],
        )
        name = f"{capture.capture_id}/screenshot.png"
        os.makedirs(os.path.join(self.tmp, os.path.dirname(name)), exist_ok=True)
        with open(os.path.join(self.tmp, name), "wb") as fh:
            fh.write(b"png-bytes")
        Capture.objects.filter(pk=capture.pk).update(screenshot=name)
        capture.refresh_from_db()
        provider = MediaFakeProvider(
            fail_on={os.path.join(self.tmp, name)}
        )

        text, image, *_ = extract_contexts(capture, provider)

        self.assertEqual(text, "summarized: an article about red trucks")
        self.assertEqual(
            image,
            [{"id": str(capture.capture_id), "context": "", "status": "failed"}],
        )


class ScreenshotResolutionTests(TestCase):
    """The context phase's treatment of a stored (or missing) screenshot."""

    def setUp(self):
        self.user = get_user_model().objects.create_user(
            "u", "u@example.com", "pw"
        )
        self.tmp = tempfile.mkdtemp(prefix="bm-media-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = patch(
            "core.storage.get_storage", return_value=_local_storage(self.tmp)
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _capture_with_screenshot(self, write_file: bool) -> Capture:
        capture = Capture.objects.create(
            user=self.user, text_sources=["an article about red trucks"]
        )
        name = f"{capture.capture_id}/screenshot.png"
        if write_file:
            path = os.path.join(self.tmp, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as fh:
                fh.write(b"png-bytes")
        Capture.objects.filter(pk=capture.pk).update(screenshot=name)
        capture.refresh_from_db()
        return capture

    def test_stored_screenshot_is_resolved_for_the_provider(self):
        capture = self._capture_with_screenshot(write_file=True)
        provider = MediaFakeProvider()

        text, image, video, audio, summary = extract_contexts(capture, provider)

        self.assertEqual(
            provider.image_calls,
            [os.path.join(self.tmp, capture.screenshot.name)],
        )
        self.assertEqual(len(image), 1)
        self.assertEqual(image[0]["id"], str(capture.capture_id))

    def test_missing_screenshot_is_skipped_not_failed(self):
        capture = self._capture_with_screenshot(write_file=False)
        provider = MediaFakeProvider()

        text, image, video, audio, summary = extract_contexts(capture, provider)

        self.assertEqual(provider.image_calls, [])  # nothing to describe
        self.assertEqual(image, [])
        # The rest of the capture still processed.
        self.assertEqual(text, "summarized: an article about red trucks")


class CaptureDeleteCleanupTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            "u", "u@example.com", "pw"
        )
        self.tmp = tempfile.mkdtemp(prefix="bm-media-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = patch(
            "core.storage.get_storage", return_value=_local_storage(self.tmp)
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _write(self, relative: str):
        path = os.path.join(self.tmp, relative)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(b"x")
        return path

    def test_delete_removes_stored_media(self):
        capture = Capture.objects.create(user=self.user)
        capture_id = str(capture.capture_id)
        self._write(f"{capture_id}/screenshot.png")
        stored = self._write(f"{capture_id}/images/a.jpg")  # new layout
        legacy = self._write("media/old.png")  # pre-per-capture-folder layout
        # A legacy capture points its screenshot at the old media/ layout.
        Capture.objects.filter(pk=capture.pk).update(screenshot="media/old.png")
        capture.refresh_from_db()

        deleted = capture.delete()

        self.assertGreater(deleted[0], 0)
        self.assertFalse(Capture.objects.filter(pk=capture.pk).exists())
        # Everything under the capture prefix ...
        self.assertFalse(os.path.exists(stored))
        # ... and the legacy screenshot file are both gone.
        self.assertFalse(os.path.exists(legacy))

    def test_storage_failure_never_blocks_delete(self):
        capture = Capture.objects.create(user=self.user)
        with patch(
            "core.storage.cleanup_capture_media", side_effect=RuntimeError("boom")
        ):
            deleted = capture.delete()
        self.assertGreater(deleted[0], 0)
        self.assertFalse(Capture.objects.filter(pk=capture.pk).exists())
