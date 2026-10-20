import uuid
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from core.api.gemini import EMBED_DIMENSIONS, GeminiProvider
from core.embedding_builder import (
    EXPECTED_DIMENSIONS,
    build_capture_embeddings,
    collect_units,
)
from core.models import Capture, CaptureContext, CaptureEmbedding
from core.search import PREVIEW_CHARS, search_captures

DIM = EXPECTED_DIMENSIONS  # what the provider is configured to produce (Matryoshka)


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
