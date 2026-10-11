import os
import re
import tempfile
import threading
import time

import requests
from django.conf import settings
from google import genai
from google.genai import errors
from langchain_text_splitters import RecursiveCharacterTextSplitter

# ------------------------------------------------------------------
# Quota guard (temporary, for the free tier)
#
# The free-tier generate_content quota is 15 requests/minute PER
# PROJECT. A capture with N sources fires N calls back-to-back and
# trips it. The guard does two things:
#   1. Paces calls: a 4.5s gap between calls keeps us at ~13/min.
#   2. Retries on 429: sleeps for Google's suggested retryDelay,
#      up to 3 attempts, so bursts finish instead of 500ing.
# The clock is shared across provider instances (class-level) so
# concurrent requests in this process pace together.
# ------------------------------------------------------------------
_CALL_GAP = 4.5
_MAX_ATTEMPTS = 3
_last_call_lock = threading.Lock()
_last_call_at = 0.0

# ------------------------------------------------------------------
# Embedding window (gemini-embedding-2)
#
# The model accepts at most EMBED_MAX_TOKENS input tokens and outputs
# a 3072-dim vector. The DB column is unconstrained `vector` (any
# dimension stores; HNSW indexes cap at 2000 dims, so search stays a
# sequential scan).
#
# The text splitter works in *characters*, so the chunk size below is
# a character heuristic calibrated to the token window (dense text can
# run ~3 chars per token). The real guarantee is the count_tokens
# validation in generate_embeddings: any piece still over
# EMBED_MAX_TOKENS is re-split until it fits.
# ------------------------------------------------------------------
EMBED_MODEL = "gemini-embedding-2"
EMBED_MAX_TOKENS = 8192
EMBED_OVERLAP_TOKENS = 800
EMBED_MAX_CHARS = EMBED_MAX_TOKENS * 3
EMBED_OVERLAP_CHARS = EMBED_OVERLAP_TOKENS * 2
# Texts at or under this length cannot exceed EMBED_MAX_TOKENS even at
# a pathological 1 token per character, so they skip count_tokens and
# are embedded directly.
EMBED_FASTPATH_CHARS = EMBED_MAX_TOKENS


class GeminiProvider:

    def __init__(self):
        self.client = genai.Client(
            api_key=settings.GEMINI_API_KEY
        )

    def _pace(self):
        global _last_call_at
        with _last_call_lock:
            wait = _CALL_GAP - (time.monotonic() - _last_call_at)
            if wait > 0:
                time.sleep(wait)
            _last_call_at = time.monotonic()

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
                model="gemini-3.5-flash-lite",
                contents=text,
            )
        )

        return response.text   #type: ignore

    def describe_image(self, image_path) -> str:
        local_path = self._resolve_file(image_path)

        try:
            uploaded_file = self.client.files.upload(
                file=local_path
            )

            response = self._guarded(
                lambda: self.client.models.generate_content(
                    model="gemini-3.5-flash-lite",
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
                    model="gemini-3.5-flash-lite",
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
        """Embed a single text that already fits the model window."""
        response = self._guarded(
            lambda: self.client.models.embed_content(
                model=EMBED_MODEL,
                contents=text,
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
                    model="gemini-3.5-flash-lite",
                    contents=[
                        "Transcribe this audio.",
                        uploaded_file,
                    ],
                )
            )
        finally:
            self._cleanup(audio_path, local_path)

        return response.text  #type: ignore
