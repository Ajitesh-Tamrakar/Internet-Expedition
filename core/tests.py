from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APITestCase

from core.api.gemini import GeminiProvider
from core.embedding_builder import build_capture_embeddings, collect_units
from core.models import Capture, CaptureContext, CaptureEmbedding

DIM = 3072  # gemini-embedding-2 default output dimension


class FakeProvider:
    """In-test stand-in for GeminiProvider: no pacing, no network.

    Returns one (text, vector) pair per generate_embeddings call. Set
    fail_on_text to simulate a failed embed for a specific text.
    """

    def __init__(self, dimensions=DIM, fail_on_text=None):
        self.dimensions = dimensions
        self.fail_on_text = fail_on_text
        self.embed_calls: list[str] = []

    def generate_embeddings(self, text):
        self.embed_calls.append(text)
        if self.fail_on_text and text == self.fail_on_text:
            raise RuntimeError("simulated embed failure")
        return [(text, [0.0] * self.dimensions)]


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
