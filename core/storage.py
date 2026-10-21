"""Storage for capture media: Supabase Storage, or a local-disk fallback.

Every media file of a capture lives under one deterministic prefix per
capture:

    <capture_id>/screenshot.<ext>
    <capture_id>/images/<source_id>.<ext>
    <capture_id>/videos/<source_id>.<ext>
    <capture_id>/audios/<source_id>.<ext>

Two backends, one interface:

* Supabase Storage — selected in bookmark/settings as the default Django
  storage backend when SUPABASE_URL is set (the `SupabaseStorage` class
  below). Writes use the service-role key (server-side only); reads use
  plain public URLs in the development phase and signed URLs once the
  bucket is made private (MEDIA_PUBLIC=False). The pipeline only ever
  asks for a URL, so that flip is confined to `url()`.
* Local disk (MEDIA_ROOT) — the fallback used by this checkout, a bare
  dev machine, and the offline test suite. The helpers below behave the
  same in both modes; the only difference is where the bytes live and
  what a "reference" points at (a full URL vs an absolute local path).

The `*_sources` JSON entries on Capture follow one convention: `url` is
a *fetchable reference* — either a bucket object path (the item is
stored in our storage) or the original external URL (it is not; e.g. it
was too large for the free plan). `original_url` always records the
source URL the client reported, for provenance. This module is the only
place that knows how to tell the two apart and how to resolve a path
into something downloadable.

Everything here is plain functions (no DRF/request objects) — the same
convention as core/embedding_builder — so the same code runs from the
API viewset, the background worker, or a management command.
"""

import io
import logging
import os
import re
import shutil
import uuid

import requests
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.core.files import File
from django.core.files.base import ContentFile
from django.core.files.storage import Storage, default_storage

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Object layout and naming
# ---------------------------------------------------------------------------


def media_object_path(capture_id, kind: str, source_id: str, extension: str = ".bin") -> str:
    """Deterministic object path: ``<capture_id>/<kind>/<source_id><ext>``.

    The capture UUID in every path is what makes storage idempotent
    (re-uploads land on the same object, never duplicates) and scoped
    (delete one capture = delete one prefix).
    """
    return f"{capture_id}/{kind}/{source_id}{extension}"


def screenshot_upload_to(instance, filename: str) -> str:
    """``upload_to`` for ``Capture.screenshot``: ``<capture_id>/<filename>``.

    The capture's UUID is already set (uuid4 default at construction)
    by the time the field saves, so the screenshot joins the same
    per-capture prefix as the ingested media.
    """
    return f"{instance.capture_id}/{filename}"


EXT_BY_CONTENT_TYPE = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
}

CONTENT_TYPE_BY_EXT = {ext: ctype for ctype, ext in EXT_BY_CONTENT_TYPE.items()}
CONTENT_TYPE_BY_EXT[".txt"] = "text/plain"


def extension_for(filename=None, content_type=None, default: str = ".bin") -> str:
    """Best-effort file extension: from the filename, else the content
    type, else `.bin`. Never rejects — Gemini is the consumer of the
    bytes, and an unknown format is still worth storing."""
    if filename:
        ext = os.path.splitext(str(filename).split("?")[0])[1]
        if ext and re.fullmatch(r"\.[a-z0-9]{1,8}", ext.lower()):
            return ext.lower()
    if content_type:
        return EXT_BY_CONTENT_TYPE.get(str(content_type).split(";")[0].strip()) or default
    return default


def content_type_for(name: str, default: str = "application/octet-stream") -> str:
    return CONTENT_TYPE_BY_EXT.get(os.path.splitext(str(name))[1].lower(), default)


# ---------------------------------------------------------------------------
# Supabase backend
# ---------------------------------------------------------------------------


def _make_client():
    """The Supabase API client (lazy import: migrations must import this
    module cleanly even where the `supabase` package is absent)."""
    from supabase import create_client

    return create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_KEY)


class SupabaseStorage(Storage):
    """Django storage backend for a Supabase Storage bucket.

    Selected as the *default* backend in bookmark/settings when
    SUPABASE_URL is set, which is what routes ``Capture.screenshot``
    (an ImageField) here: the web process uploads it during
    ``POST /captures/``, and ``screenshot.url`` serializes to the
    bucket URL in API responses.
    """

    def __init__(self, bucket=None, public=None, ttl=None, client=None):
        if not getattr(settings, "SUPABASE_URL", ""):
            raise ImproperlyConfigured(
                "core.storage.SupabaseStorage requires SUPABASE_URL to be set "
                "(without it, the local-disk fallback is used instead)."
            )
        super().__init__()
        self._client = client if client is not None else _make_client()
        self.bucket = bucket or getattr(settings, "SUPABASE_BUCKET", "captures")
        self.public = (
            getattr(settings, "MEDIA_PUBLIC", True) if public is None else public
        )
        self.ttl = (
            getattr(settings, "MEDIA_SIGNED_URL_TTL", 3600) if ttl is None else ttl
        )

    @property
    def _api(self):
        return self._client.storage.from_(self.bucket)

    def _save(self, name, content):
        data = content.read()
        self._api.upload(
            name,
            data,
            file_options={
                "content-type": content_type_for(name),
                "upsert": "true",  # re-uploading a path replaces the object
            },
        )
        # Storage.save() uses the returned name (it re-validates it).
        return name

    def _open(self, name, mode="rb"):
        return File(io.BytesIO(self._api.download(name)))

    def exists(self, name):
        # The base Storage.exists() would _open() (download the whole
        # file) just to check; the storage API has a cheap check.
        return bool(self._api.exists(name))

    def delete(self, name):
        if name and self._api.exists(name):
            self._api.remove([name])

    def list_prefix(self, prefix: str) -> list[str]:
        """Full object names stored under ``prefix`` (the capture folder)."""
        items = self._api.list(prefix)
        return [f"{prefix}/{item['name']}" for item in items if item.get("name")]

    def url(self, name):
        if self.public:
            return self._api.get_public_url(name)
        response = self._api.create_signed_url(name, self.ttl)
        return response["signedURL"] or response["signedUrl"]


# ---------------------------------------------------------------------------
# Mode-agnostic helpers (work against whichever backend is active)
# ---------------------------------------------------------------------------


def is_external_url(value) -> bool:
    """A fetchable reference is *external* when it carries an http(s)
    scheme. No scheme = a path in our own storage bucket."""
    return isinstance(value, str) and value.startswith(("http://", "https://"))


def get_storage() -> Storage:
    """The active media backend (Supabase, or local disk in fallback).

    Django 5.1+ exposes `default_storage` as a lazy object (not a
    factory): use it directly, it resolves the STORAGES['default']
    backend on first use.
    """
    return default_storage


def fetchable_reference(object_name: str, storage: Storage | None = None) -> str:
    """Something ``gemini.GeminiProvider._resolve_file`` can consume for a
    stored object: a full URL (Supabase mode) or an absolute local path
    (fallback mode, where ``url()`` is a relative /media/ link)."""
    storage = storage or get_storage()
    url = storage.url(object_name)
    if is_external_url(url):
        return url
    base = getattr(storage, "base_location", None) or str(settings.MEDIA_ROOT)
    return os.path.join(base, object_name)


def media_exists(object_name: str, storage: Storage | None = None) -> bool:
    storage = storage or get_storage()
    return storage.exists(object_name)


def save_bytes(
    object_name: str, data: bytes, storage: Storage | None = None
) -> str:
    """Store ``data`` at ``object_name`` in the active backend; returns
    the object name (the path to keep in the source entries)."""
    storage = storage or get_storage()
    return storage.save(object_name, ContentFile(data))


def cleanup_capture_media(
    capture_id, legacy_screenshot_name=None, storage: Storage | None = None
) -> None:
    """Best-effort removal of a capture's stored media. Never raises.

    Removes everything under ``<capture_id>/`` in the active backend,
    plus a legacy screenshot file (the pre-per-capture-folder
    ``media/...`` layout) when named.
    """
    storage = storage or get_storage()
    prefix = str(capture_id)
    try:
        if isinstance(storage, SupabaseStorage):
            names = storage.list_prefix(prefix)
            if names:
                storage._api.remove(names)
            if legacy_screenshot_name:
                storage.delete(legacy_screenshot_name)  # guarded by exists()
        else:
            base = getattr(storage, "base_location", None) or str(settings.MEDIA_ROOT)
            shutil.rmtree(os.path.join(base, prefix), ignore_errors=True)
            if legacy_screenshot_name:
                path = os.path.join(base, legacy_screenshot_name)
                if os.path.exists(path):
                    os.remove(path)
    except Exception:
        logger.warning(
            "media cleanup failed for capture %s", capture_id, exc_info=True
        )


# ---------------------------------------------------------------------------
# Media ingest: pull still-external sources into the storage backend
# ---------------------------------------------------------------------------


class MediaDownloadError(RuntimeError):
    """One media source could not be downloaded from its original URL."""

    def __init__(self, url: str, reason: str):
        self.url = url
        self.reason = reason
        super().__init__(f"{url} ({reason})")


class MediaIngestError(RuntimeError):
    """One or more media sources failed to download (all causes listed).

    The message is shaped for ``Capture.error_note`` (500-char cap):
    up to five causes, the rest counted.
    """

    def __init__(self, failures: list[tuple[str, str]]):
        self.failures = failures
        detail = "; ".join(f"{url} ({reason})" for url, reason in failures[:5])
        if len(failures) > 5:
            detail += f" (+{len(failures) - 5} more)"
        super().__init__(f"media ingest failed: {detail}")


_DOWNLOAD_HEADERS = {"User-Agent": "Mozilla/5.0 (bookmark)"}


def download_capped(url: str, max_bytes: int) -> tuple[bytes | None, bool, str]:
    """Download ``url``, aborting as soon as it exceeds ``max_bytes``.

    Returns ``(data, oversized, content_type)``. Raises
    :class:`MediaDownloadError` for HTTP or network failures. The
    browser-like UA matches gemini.py's: some hosts 403 the default
    python-requests user agent.
    """
    timeout = getattr(settings, "MEDIA_DOWNLOAD_TIMEOUT", 60)
    try:
        response = requests.get(
            url, timeout=timeout, headers=_DOWNLOAD_HEADERS, stream=True
        )
    except requests.RequestException as err:
        raise MediaDownloadError(url, f"network error: {type(err).__name__}") from err

    if response.status_code >= 400:
        raise MediaDownloadError(url, f"HTTP {response.status_code}")

    content_type = response.headers.get("Content-Type", "")
    data = b""
    try:
        for chunk in response.iter_content(chunk_size=64 * 1024):
            data += chunk
            if len(data) > max_bytes:
                return None, True, content_type
    except requests.RequestException as err:
        raise MediaDownloadError(url, f"download aborted: {type(err).__name__}") from err
    return data, False, content_type


_SOURCE_FIELDS = (
    ("image_sources", "images"),
    ("video_sources", "videos"),
    ("audio_sources", "audios"),
)


def ingest_capture_media(capture, storage: Storage | None = None):
    """Store every still-external media source of ``capture`` in the
    storage backend, and rewrite its ``*_sources`` entries to point at
    the stored objects. Returns the (refreshed) capture.

    Idempotent by construction: an entry is only processed while its
    ``url`` is an external URL *and* ``original_url`` is unset — i.e.
    ingest has not looked at it yet. A re-run is a fast no-op and never
    re-downloads stored media, which is what makes retries and the
    worker's claim-guard safe.

    Outcomes per source:
      * downloaded and stored -> ``url`` rewritten to the bucket path,
        ``original_url`` records the source;
      * larger than ``MEDIA_MAX_FILE_BYTES`` -> ``original_url`` set but
        ``url`` kept external (the free storage plan cannot hold it; it
        stays link-based, exactly as before this module existed);
      * download/storage failure -> collected; after ALL sources are
        assessed, the successful rewrites are saved and the failures
        are raised together as :class:`MediaIngestError` (a retry
        re-downloads only what actually failed).
    """
    max_bytes = getattr(settings, "MEDIA_MAX_FILE_BYTES", 50 * 1024 * 1024)
    storage = storage or get_storage()

    changed = False
    failures: list[tuple[str, str]] = []

    for field_name, kind in _SOURCE_FIELDS:
        entries = getattr(capture, field_name) or []
        if not isinstance(entries, list):
            continue

        new_entries = []
        for entry in entries:
            if not isinstance(entry, dict):
                new_entries.append(entry)
                continue

            url = (entry.get("url") or "").strip()
            if not is_external_url(url) or entry.get("original_url") is not None:
                # Stored in our bucket, already assessed, or empty: leave it.
                new_entries.append(entry)
                continue

            new_entry = dict(entry)
            if not new_entry.get("id"):
                new_entry["id"] = str(uuid.uuid4())
            new_entry["original_url"] = url

            try:
                data, oversized, content_type = download_capped(url, max_bytes)
            except MediaDownloadError as err:
                failures.append((url, err.reason))
                new_entries.append(entry)  # unchanged: a retry re-attempts it
                continue

            if oversized:
                logger.info(
                    "capture %s: %s exceeds the %d byte cap; kept link-based",
                    capture.capture_id,
                    url,
                    max_bytes,
                )
                new_entries.append(new_entry)
                changed = True
                continue

            name = media_object_path(
                str(capture.capture_id),
                kind,
                str(new_entry["id"]),
                extension_for(url, content_type),
            )
            try:
                save_bytes(name, data, storage=storage)
            except Exception as err:
                failures.append(
                    (url, f"storage upload failed: {type(err).__name__}")
                )
                new_entries.append(entry)
                continue

            new_entry["url"] = name
            new_entries.append(new_entry)
            changed = True

        if new_entries != entries:
            setattr(capture, field_name, new_entries)
            changed = True

    if changed:
        capture.save()

    if failures:
        raise MediaIngestError(failures)

    return capture


def resolve_source(source, storage: Storage | None = None):
    """A fetchable reference for one media source — a ``*_sources``
    entry, or a bare string.

    A source pointing into our storage resolves to a full URL (Supabase
    mode) or an absolute local path (fallback mode) — exactly what
    ``gemini.GeminiProvider._resolve_file`` consumes, so the provider
    itself needs no changes. An external URL is returned as-is: the
    provider downloads it from the origin, which is now only a fallback
    for link-based sources.
    """
    url = (source.get("url") or "") if isinstance(source, dict) else (source or "")
    if url and not is_external_url(url):
        return fetchable_reference(url, storage=storage)
    return source
