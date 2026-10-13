import os
import re
import tempfile
import time

import requests
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from google import genai
from google.genai import errors, types
from langchain_text_splitters import RecursiveCharacterTextSplitter

from core.models import ProviderRateSlot

# ------------------------------------------------------------------
# Quota guard
#
# The Gemini quota (15 requests/minute on the free tier; more once the
# paid tier is approved) is per PROJECT: it covers every user and every
# process in the deployment. A capture with N sources fires N calls
# back-to-back and would trip it. The guard does two things:
#   1. Paces calls: every call must first reserve a slot against a
#      SHARED database clock (ProviderRateSlot, one row), which
#      serializes ALL Gemini calls across the whole deployment to one
#      per GEMINI_CALL_GAP_SECONDS. The clock is in the database rather
#      than in process memory so any number of web/worker processes
#      pace together (two in-memory clocks would double the quota).
#   2. Retries on 429: sleeps for Google's suggested retryDelay,
#      up to 3 attempts, so bursts finish instead of 500ing.
# ------------------------------------------------------------------
_CALL_GAP_DEFAULT = 4.5  # 15 req/min budget -> ~13/min at 4.5s spacing
_MAX_ATTEMPTS = 3

# ------------------------------------------------------------------
# Embedding window (gemini-embedding-2)
#
# The model accepts at most EMBED_MAX_TOKENS input tokens and is
# Matryoshka: it can be asked for any of 768 / 1536 / 3072 output
# dimensions. We request EMBED_DIMENSIONS — 1536: half the storage of
# 3072, and under pgvector's 2000-dim HNSW cap, so an index becomes
# possible (the current no-LIMIT search query still seq-scans — HNSW
# index scans require ORDER BY ... LIMIT).
#
# The DB column stays unconstrained `vector`: rows written before the
# 1536 switch are 3072-dim and must still store; search skips any row
# whose dimension doesn't match the query vector.
#
# The text splitter works in *characters*, so the chunk size below is
# a character heuristic calibrated to the token window (dense text can
# run ~3 chars per token). The real guarantee is the count_tokens
# validation in generate_embeddings: any piece still over
# EMBED_MAX_TOKENS is re-split until it fits.
# ------------------------------------------------------------------
# Model names read from settings (with these defaults) so the paid-API
# swap is a .env change, not a code change.
EMBED_MODEL = getattr(settings, "GEMINI_EMBED_MODEL", "gemini-embedding-2")
# Requested output dimension (Matryoshka). Single source of truth —
# the embedding builder enforces it, search matches against it.
EMBED_DIMENSIONS = 1536
EMBED_MAX_TOKENS = 8192
EMBED_OVERLAP_TOKENS = 800
EMBED_MAX_CHARS = EMBED_MAX_TOKENS * 3
EMBED_OVERLAP_CHARS = EMBED_OVERLAP_TOKENS * 2
# Texts at or under this length cannot exceed EMBED_MAX_TOKENS even at
# a pathological 1 token per character, so they skip count_tokens and
# are embedded directly.
EMBED_FASTPATH_CHARS = EMBED_MAX_TOKENS

# ------------------------------------------------------------------
# Summary (unified context)
#
# One generate_content call over the whole capture: every populated
# per-source context (text, image descriptions, video descriptions,
# audio transcripts) joined into one labeled document.
#
# We deliberately do NOT pre-truncate: the model window is large and
# we want to observe real unified-doc sizes before calibrating a cap.
# If a document ever outgrows the window, the API returns a 400, the
# caller catches it (the summary is an optional path), and
# is_window_overflow() flags it in the logs so we learn how big the
# data actually gets.
# ------------------------------------------------------------------
SUMMARY_MODEL = getattr(
    settings, "GEMINI_SUMMARY_MODEL", "gemini-3.5-flash-lite"
)

_UNIFIED_SUMMARY_PROMPT = (
    "The text after this instruction is a saved web capture, organized "
    "into labeled sections: extracted text, image descriptions, video "
    "descriptions, and audio transcripts. Some sections may be missing. "
    "Write a factual summary of the ENTIRE capture, 500-1000 words "
    "(shorter if the content is thin - never pad to reach the target). "
    "Cover the main topic, the key facts and claims, notable entities "
    "(people, organizations, products, places), and concrete details "
    "such as numbers and dates. Preserve distinctive terms and keywords "
    "from the content instead of paraphrasing them away, and write in "
    "the dominant language of the source content. Output only the "
    "summary itself - no preamble, no title, no 'Here is...' wording."
)


def is_window_overflow(err) -> bool:
    """Heuristic: does this API error mean the *input* exceeded the
    model's context window?

    Google answers an oversized generate_content input with a 400 whose
    message mentions the limit. Used for logging only: we send the full
    unified document today, and a recognizable log line (with the doc
    size, added by the caller) is what tells us we need a cap.
    """
    if not isinstance(err, errors.ClientError) or getattr(err, "code", None) != 400:
        return False
    message = (getattr(err, "message", "") or "").lower()
    return any(
        marker in message
        for marker in ("too long", "exceed", "window", "token", "payload")
    )


def _model(setting_name: str, default: str) -> str:
    """A model name from settings, falling back to `default`.

    Read per call (not at import) so a settings change is observable
    without a code change - and testable via override_settings."""
    return getattr(settings, setting_name, default)


def reserve_pace_slot(gap_seconds: float) -> None:
    """Block until the shared pace slot allows a new API call, then
    claim it.

    The slot is a single database row, so every process in the
    deployment (web servers, workers, any number of them) paces
    together against the project's single API quota. The claim is an
    atomic read-then-stamp inside a row lock: a process that finds the
    slot still fresh releases the lock, sleeps the remaining gap, and
    re-checks - so exactly one process stamps the slot per interval.
    """
    while True:
        with transaction.atomic():
            slot, _ = ProviderRateSlot.objects.select_for_update().get_or_create(
                key="gemini"
            )
            wait = gap_seconds - (time.time() - slot.last_call_at.timestamp())
            if wait <= 0:
                slot.last_call_at = timezone.now()
                slot.save(update_fields=["last_call_at"])
                return
        time.sleep(min(wait, 0.25))


class GeminiProvider:

    def __init__(self):
        self.client = genai.Client(
            api_key=settings.GEMINI_API_KEY
        )

    def _pace(self):
        """Pace this call against the shared database slot.

        The gap comes from GEMINI_CALL_GAP_SECONDS: 4.5s keeps the free
        tier under its 15 req/min project quota; lower it (one settings
        change, no code change) when the paid tier lands."""
        reserve_pace_slot(
            getattr(settings, "GEMINI_CALL_GAP_SECONDS", _CALL_GAP_DEFAULT)
        )

    @staticmethod
    def _retry_delay(err):
        """Read Google's suggested retryDelay (e.g. '51s') from a 429."""
        details = err.details if isinstance(err.details, dict) else {}
        for block in (details.get("error", {}).get("details") or []):
            if isinstance(block, dict) and "retryDelay" in block:
                m = re.match(r"([\d.]+)s", block["retryDelay"])
                if m:
                    return min(float(m.group(1)), 120)
        return None

    def _guarded(self, fn):
        """Run a Gemini API call (generate_content or embed_content),
        paced, with 429 retry."""
        for attempt in range(_MAX_ATTEMPTS):
            self._pace()
            try:
                return fn()
            except errors.ClientError as err:
                if err.code != 429 or attempt == _MAX_ATTEMPTS - 1:
                    raise
                time.sleep(self._retry_delay(err) or 60)
        raise RuntimeError("unreachable")

    def _resolve_file(self, source) -> str:
        """Return a local file path for a media source.

        Accepts a local path, a remote http(s) URL, or a source dict
        with a "url" key (as stored in *_sources JSON fields). Remote
        files are downloaded to a temp file.
        """
        if isinstance(source, dict):
            source = source.get("url", "")
        if not source:
            raise ValueError("No file source provided")
        if not source.startswith(("http://", "https://")):
            return source
        suffix = os.path.splitext(source.split("?")[0])[1] or ".bin"
        fd, path = tempfile.mkstemp(suffix=suffix)
        os.close(fd)
        try:
            # A browser-like UA: some hosts (e.g. Wikimedia) 403 the
            # default python-requests user agent.
            resp = requests.get(
                source,
                timeout=60,
                headers={"User-Agent": "Mozilla/5.0 (bookmark)"}
            )
            resp.raise_for_status()
            with open(path, "wb") as f:
                f.write(resp.content)
        except Exception:
            os.remove(path)
            raise
        return path

    def _cleanup(self, source, local_path):
        if isinstance(source, str) and local_path != source and os.path.exists(local_path):
            os.remove(local_path)

    def summarize_text(self, text: str) -> str:
        response = self._guarded(
            lambda: self.client.models.generate_content(
                model=_model("GEMINI_FLASH_LITE_MODEL", "gemini-3.5-flash-lite"),
                contents=text,
            )
        )

        return response.text   #type: ignore

    def unified_context(self, unified_text: str) -> str:
        """Summarize an entire capture in a single call.

        `unified_text` is the joined, source-labeled document produced
        from the populated per-source contexts (see
        core.api.views.build_unified_text). Returns the summary, or ""
        when the input is empty (no API call is made).

        All other errors - including the document outgrowing the model
        window - propagate to the caller: the summary is an optional
        path, and the caller degrades to a null summary rather than
        failing the whole capture.
        """
        text = (unified_text or "").strip()
        if not text:
            return ""

        response = self._guarded(
            lambda: self.client.models.generate_content(
                model=_model("GEMINI_SUMMARY_MODEL", SUMMARY_MODEL),
                contents=_UNIFIED_SUMMARY_PROMPT + "\n\n" + text,
            )
        )

        return (response.text or "").strip()  # type: ignore

    def describe_image(self, image_path) -> str:
        local_path = self._resolve_file(image_path)

        try:
            uploaded_file = self.client.files.upload(
                file=local_path
            )

            response = self._guarded(
                lambda: self.client.models.generate_content(
                    model=_model("GEMINI_FLASH_LITE_MODEL", "gemini-3.5-flash-lite"),
                    contents=[
                        "Describe this image in detail.",
                        uploaded_file,
                    ],
                )
            )
        finally:
            self._cleanup(image_path, local_path)

        return response.text  #type: ignore

    def describe_video(self, video_path) -> str:
        local_path = self._resolve_file(video_path)

        try:
            uploaded_file = self.client.files.upload(
                file=local_path
            )

            response = self._guarded(
                lambda: self.client.models.generate_content(
                    model=_model("GEMINI_FLASH_LITE_MODEL", "gemini-3.5-flash-lite"),
                    contents=[
                        "Describe this video in detail.",
                        uploaded_file,
                    ],
                )
            )
        finally:
            self._cleanup(video_path, local_path)

        return response.text #type: ignore

    def generate_embedding(self, text: str) -> list[float]:
        """Embed a single text that already fits the model window,
        compressed to EMBED_DIMENSIONS dimensions."""
        response = self._guarded(
            lambda: self.client.models.embed_content(
                model=EMBED_MODEL,
                contents=text,
                config=types.EmbedContentConfig(
                    output_dimensionality=EMBED_DIMENSIONS
                ),
            )
        )

        return response.embeddings[0].values  #type: ignore

    def count_tokens(self, text: str) -> int:
        """How many tokens `text` consumes in the embedding model.
        Paced and retried like every other call."""
        response = self._guarded(
            lambda: self.client.models.count_tokens(
                model=EMBED_MODEL,
                contents=text,
            )
        )

        return response.total_tokens  #type: ignore

    def _ensure_fits(self, chunk: str) -> list[str]:
        """Return `chunk` as a list of pieces that each fit the model
        window, splitting on measured tokens (count_tokens), so it is
        exact regardless of the character-based pre-split. If the
        splitter cannot shrink a chunk any further (e.g. one unbreakable
        run of text longer than the window), the chunk is returned as-is
        and the embed call fails loudly instead of looping forever."""
        if self.count_tokens(chunk) <= EMBED_MAX_TOKENS:
            return [chunk]

        pieces = [
            piece
            for piece in RecursiveCharacterTextSplitter(
                chunk_size=max(len(chunk) // 2, 1),
                chunk_overlap=0,
            ).split_text(chunk)
            if piece.strip()
        ]
        if len(pieces) <= 1:
            return [chunk]

        out: list[str] = []
        for piece in pieces:
            out.extend(self._ensure_fits(piece))
        return out

    def generate_embeddings(self, text: str) -> list[tuple[str, list[float]]]:
        """Embed a possibly long text, returning (chunk_text, vector)
        pairs in order.

        Short texts (at or under EMBED_FASTPATH_CHARS characters cannot
        exceed the model window) are embedded directly. Longer texts are
        pre-split with a character-based splitter (EMBED_MAX_CHARS with
        EMBED_OVERLAP_CHARS overlap to preserve context across
        boundaries), each piece is validated with count_tokens and
        re-split until it fits, then each piece is embedded (paced,
        429-retried)."""
        if not text or not text.strip():
            return []

        if len(text) <= EMBED_FASTPATH_CHARS:
            return [(text, self.generate_embedding(text))]

        pieces = [
            piece
            for piece in RecursiveCharacterTextSplitter(
                chunk_size=EMBED_MAX_CHARS,
                chunk_overlap=EMBED_OVERLAP_CHARS,
            ).split_text(text)
            if piece.strip()
        ]

        final: list[str] = []
        for piece in pieces:
            final.extend(self._ensure_fits(piece))

        return [(chunk, self.generate_embedding(chunk)) for chunk in final]


    def transcribe_audio(self, audio_path) -> str:
        local_path = self._resolve_file(audio_path)

        try:
            uploaded_file = self.client.files.upload(
                file=local_path
            )

            response = self._guarded(
                lambda: self.client.models.generate_content(
                    model=_model("GEMINI_FLASH_LITE_MODEL", "gemini-3.5-flash-lite"),
                    contents=[
                        "Transcribe this audio.",
                        uploaded_file,
                    ],
                )
            )
        finally:
            self._cleanup(audio_path, local_path)

        return response.text  #type: ignore
