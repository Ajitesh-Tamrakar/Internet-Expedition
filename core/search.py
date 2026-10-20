"""Semantic search over a user's captures.

Plain functions only — no DRF request/response/serializer objects — so
the exact same code runs from the API viewset, or a future management
command / worker.

Stages:
  1. embed the query text via the provider (one paced API call; the
     caller doesn't care which model does it — the provider is the
     source of truth for the model name)
  2. score every one of the user's stored embedding rows against that
     vector with Postgres (pgvector cosine; computed server-side, the
     vectors are never fetched into Python)
  3. group rows by capture: each capture appears once, ranked by its
     best chunk, carrying all of its chunks (best-first)

Intentional v1 behaviors:
  * No k / min_score by default — every capture is returned so the
    caller can see the full score distribution before choosing a
    threshold.
  * The scan is sequential: this query is a full ranking with no
    LIMIT, and HNSW index scans require ORDER BY ... LIMIT, so no
    index would be used anyway. Fine at personal scale.
  * The query vector and the stored rows must come from the same
    embedding model/dimension for the comparison to be meaningful.
    Rows written before the 1536-dim switch (3072-dim) are skipped
    rather than crashing the distance op.
"""

from django.db.models import Func, IntegerField
from pgvector.django import CosineDistance

from core.api.gemini import GeminiProvider
from core.models import Capture, CaptureContext, CaptureEmbedding

# Chunk text in results is a preview — full text is retrievable from
# GET /capture-embedding/.
PREVIEW_CHARS = 200


def search_captures(
    user,
    query: str,
    k: int | None = None,
    min_score: float | None = None,
    provider: GeminiProvider | None = None,
) -> list[dict]:
    """Return the user's captures ranked by relevance to `query`.

    Each result dict:
      capture_id  — the Capture primary key
      rank        — 1-based position after filtering
      score       — the capture's best-chunk cosine similarity
                    (1 = same direction, 0 = unrelated; higher = better)
      summary_text— the capture's context summary (None if absent)
      created_at  — when the capture was saved
      chunks      — all of the capture's embedding rows, each with its
                    own score and a text preview, best-first

    `k` caps the number of captures and `min_score` is a floor on the
    capture's best-chunk score; both apply at capture level only and
    both default to off. A capture that enters or leaves on its best
    chunk always carries all of its chunks.
    """
    provider = provider or GeminiProvider()
    query_vector = provider.generate_embedding(query)

    # Legacy rows (3072-dim, written before the 1536 switch) must not
    # participate: pgvector errors on mixed-dimension distance ops.
    # The dims filter runs first, so the annotate below only ever sees
    # vectors matching the query's dimension.
    base = (
        CaptureEmbedding.objects
        .filter(user=user, embedding__isnull=False)
        # output_field: without it, Func inherits the VectorField type
        # and Django would try to prepare the int as a vector.
        .annotate(_dims=Func("embedding", function="vector_dims", output_field=IntegerField()))
        .filter(_dims=len(query_vector))
    )

    rows = (
        base
        .annotate(score=1 - CosineDistance("embedding", query_vector))
        .values("capture_id", "source_key", "text", "score")
        .order_by("score")
    )

    # Group rows by capture; headline score = best (max) chunk.
    by_capture: dict = {}
    for row in rows:
        entry = by_capture.setdefault(
            row["capture_id"],
            {
                "capture_id": row["capture_id"],
                "score": None,
                "chunks": [],
            },
        )
        entry["chunks"].append(
            {
                "source_key": row["source_key"],
                "score": row["score"],
                "text": (row["text"] or "")[:PREVIEW_CHARS],
            }
        )
        if entry["score"] is None or row["score"] > entry["score"]:
            entry["score"] = row["score"]

    # Chunks are best-first within each capture.
    for entry in by_capture.values():
        entry["chunks"].sort(key=lambda c: c["score"], reverse=True)

    results = sorted(by_capture.values(), key=lambda r: r["score"], reverse=True)

    if min_score is not None:
        results = [r for r in results if r["score"] >= min_score]
    if k is not None:
        results = results[:k]

    # Metadata for the surviving captures only.
    capture_ids = [r["capture_id"] for r in results]
    captures = {
        c.capture_id: c
        for c in Capture.objects.filter(capture_id__in=capture_ids)
    }
    # `capture_id` on the model is the related Capture instance; the raw
    # UUID (the FK value) is `capture_id_id`.
    contexts = {
        ctx.capture_id_id: ctx
        for ctx in CaptureContext.objects.filter(capture_id__in=capture_ids)
    }

    for rank, r in enumerate(results, start=1):
        capture = captures.get(r["capture_id"])
        context = contexts.get(r["capture_id"])
        r["rank"] = rank
        r["summary_text"] = context.summary_text if context else None
        r["created_at"] = capture.created_at if capture else None

    return results
