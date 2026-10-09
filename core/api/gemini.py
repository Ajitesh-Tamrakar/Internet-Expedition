import os
import re
import tempfile
import threading
import time

import requests
from django.conf import settings
from google import genai
from google.genai import errors

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
        """Run a generate_content call, paced, with 429 retry."""
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
        response = self.client.models.embed_content(
            model="gemini-embedding-2",
            contents=text,
        )

        return response.embeddings[0].values  #type: ignore


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
