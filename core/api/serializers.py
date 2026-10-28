import base64
import json
import math
import os
import re
import uuid
from pathlib import Path

from django.conf import settings
from django.core.files.base import ContentFile, File
from django.db import models
from rest_framework import serializers

from core import storage as media_storage
from core.models import Capture, CaptureContext, CaptureEmbedding


# ---------------------------------------------------------------------------
# Smart metadata (section 4: B3 + B4 + B5)
#
# The capture payload is a superset of the historical contract: the
# extension's metadata format evolves as more kinds of saved content are
# supported, so the serializer is schema-aware instead of a fixed field
# list:
#   * a key with a dedicated model column (source_url, metadata, ...) is
#     recognized *because the serializer's field map is built from the
#     model* and validates against that column as before;
#   * an eligible extra key with no dedicated column is merged into the
#     JSON `metadata` field, so a new property needs no migration;
#   * server-managed names (identity, ownership, pipeline state) are
#     derived from the model schema — never a hand-maintained duplicate
#     list — and can never reach the model from client input.
# ---------------------------------------------------------------------------

# Request-level carrier keys: they appear in the payload but are not model
# fields — create() consumes them directly (the `text`/`media` JSON and
# the screenshot's `image` data-URL / file part). They are contract, not
# metadata, and must never be swept into `metadata` as if they were extra
# fields.
CONTRACT_FIELDS = frozenset({"text", "media", "image"})

# Deeper than any metadata worth keeping: a structural guard on the merged
# object, not a tunable knob.
METADATA_MAX_DEPTH = 32


def server_managed_field_names() -> frozenset:
    """The names a client must never be able to write on a Capture.

    Derived from the model's own schema plus the serializer's own
    read-only declaration — never a hand-maintained duplicate list:
    the primary key (identity), relational fields (ownership),
    auto-managed timestamps, and every field the serializer marks
    read-only (the pipeline's `status` / `error_note`).
    """
    names = set()
    for field in Capture._meta.fields:
        # auto_now/auto_now_add exist only on DateTimeField; the
        # getattr fallback keeps the check uniform across field types.
        if (
            field.primary_key
            or getattr(field, "auto_now", False)
            or getattr(field, "auto_now_add", False)
            or isinstance(
                field,
                (
                    models.ForeignKey,
                    models.OneToOneField,
                    models.ManyToManyField,
                ),
            )
        ):
            names.add(field.name)
    names.update(CaptureSerializer.Meta.read_only_fields)
    return frozenset(names)


def assert_acceptable_metadata(metadata: dict, max_key_length: int) -> None:
    """Raise ValidationError when the merged metadata is not acceptable
    JSON.

    Keys must be non-empty strings within the length gate; values must
    be plain JSON (string/number/boolean/null/list/object) with finite
    numbers; nesting must stay within METADATA_MAX_DEPTH. Checking
    value types here also guarantees the later json.dumps size gate can
    never fail with a 500 on an exotic object.
    """

    def walk(value, depth: int) -> None:
        if isinstance(value, dict):
            if depth > METADATA_MAX_DEPTH:
                raise serializers.ValidationError(
                    {
                        "metadata": (
                            "must be nested no more than "
                            f"{METADATA_MAX_DEPTH} levels deep."
                        )
                    }
                )
            for key, item in value.items():
                if not isinstance(key, str) or not 1 <= len(key) <= max_key_length:
                    raise serializers.ValidationError(
                        {
                            "metadata": (
                                "keys must be non-empty strings of at most "
                                f"{max_key_length} characters."
                            )
                        }
                    )
                walk(item, depth + 1)
        elif isinstance(value, list):
            if depth > METADATA_MAX_DEPTH:
                raise serializers.ValidationError(
                    {
                        "metadata": (
                            "must be nested no more than "
                            f"{METADATA_MAX_DEPTH} levels deep."
                        )
                    }
                )
            for item in value:
                walk(item, depth + 1)
        elif value is None or isinstance(value, (str, bool)):
            return
        elif isinstance(value, int):
            return
        elif isinstance(value, float):
            if not math.isfinite(value):
                raise serializers.ValidationError(
                    {"metadata": "numbers must be finite."}
                )
            return
        else:
            raise serializers.ValidationError(
                {
                    "metadata": (
                        "values must be strings, numbers, booleans, null, "
                        "lists, or objects."
                    )
                }
            )

    walk(metadata, 0)


class CaptureSerializer(serializers.ModelSerializer):
    class Meta:
        model = Capture
        fields = "__all__"
        # status/error_note are the background pipeline's, not the
        # client's: the client polls status, it never sets it (retry
        # goes through POST /captures/<id>/retry/).
        read_only_fields = ["user", "status", "error_note"]

    def to_internal_value(self, data):
        """Validate the payload, then merge eligible extra fields into
        ``metadata``.

        Schema-aware: a key is *recognized* when it has a dedicated
        model column — that is exactly the serializer's own field map
        (DRF builds it from the model, so there is no duplicate list to
        keep in sync) — and it validates against that column as before.
        Any other eligible top-level key (the extension may gain
        properties without a migration) is merged into the JSON
        ``metadata`` field:

        * explicit ``metadata`` wins over a same-named extra field —
          the deterministic conflict rule: the client said it on
          purpose;
        * ``metadata`` omitted → the model default ({});
        * ``metadata`` null with no extra fields → null (preserved,
          section 1 behavior);
        * ``metadata`` null with extra fields → a dict of the extras
          (they need a home; dropping them would lose data).

        ``CONTRACT_FIELDS`` (``text``/``media``/``image``) are the
        request-level carriers create() consumes directly: not
        metadata, never merged. Uploaded file parts likewise: for
        multipart requests DRF surfaces them inside ``data`` (that is
        how declared file fields read), and create() consumes them
        from ``request.FILES`` — never merged. Server-managed names
        (see ``server_managed_field_names``) are read-only fields,
        which DRF already ignores in input, and are additionally kept
        out of the merge so they can never leak into the stored object.
        """
        result = super().to_internal_value(data)
        result["metadata"] = self._merged_metadata(data, result)
        return result

    def _merged_metadata(self, data, validated: dict):
        """Build the final ``metadata`` value from the explicit field
        plus the eligible extra top-level keys. Raises ValidationError
        for ineligible keys/values, an over-deep/over-structured
        object, or an object over the size gate."""
        max_size = getattr(settings, "METADATA_MAX_SIZE", 64 * 1024)
        max_key_length = getattr(settings, "METADATA_MAX_KEY_LENGTH", 128)

        recognized = set(self.fields)
        protected = server_managed_field_names()

        extras = {}
        for key, value in data.items():
            if key in recognized or key in CONTRACT_FIELDS or key in protected:
                continue
            # For multipart requests DRF merges the uploaded file parts
            # into request.data (in addition to request.FILES, where
            # create() reads them — see _attached). A file object is
            # contract, not a metadata value.
            if isinstance(value, File):
                continue
            extras[key] = value

        merged = dict(extras)
        if "metadata" in validated:
            meta = validated["metadata"]
            if meta:
                # Conflict rule: the explicit metadata object wins.
                merged.update(meta)
            elif not extras:
                # An explicit null with nothing else to house stays null.
                return None

        assert_acceptable_metadata(merged, max_key_length)
        size = len(json.dumps(merged, ensure_ascii=False).encode("utf-8"))
        if size > max_size:
            raise serializers.ValidationError(
                {
                    "metadata": (
                        f"exceeds the {max_size} byte limit ({size} bytes)."
                    )
                }
            )
        return merged

    def create(self, validated_data):
        """Create the capture, and store its media in the storage backend.

        The payload is a superset of the historical JSON contract:

        * JSON (as before): ``media.images/videos/audios`` items are
          ``{"url": ...}`` — the client sends links, the worker's media
          ingest step later downloads them into the bucket.
        * multipart (extension that collected the files itself): the
          same ``media`` JSON object is sent as a form field, plus file
          parts named ``file:<kind>:<index>`` (index = the item's
          position in the ``media.<kind>`` list). An item with a paired
          file part is stored *now*, during this request, and its entry
          keeps the original URL as ``original_url``.
        * The screenshot has two carriers: a multipart file part named
          ``file:image:0`` (the extension's contract — raw bytes, no
          base64 overhead) or a base64 data-URL string in the ``image``
          field (the historical JSON contract, kept for other clients).
          Both are stored *now*, in the web process, under the capture's
          own prefix; when both are present the file part wins.

        Both forms may be mixed in one request, and every item shape
        the old client sends is accepted unchanged.
        """
        request = self.context["request"]
        data = request.data
        files = getattr(request, "FILES", None) or {}

        media = data.get("media") or {}
        if isinstance(media, str):
            # multipart: the JSON object arrives as a plain form field.
            try:
                media = json.loads(media)
            except ValueError:
                raise serializers.ValidationError(
                    {"media": "Must be a JSON object."}
                )

        # "text" may arrive as a single string or a list; store it as a
        # list. (In multipart the extension may send the JSON list as
        # one field; parse it when it clearly is one.)
        text = data.get("text") or []
        if isinstance(text, str):
            stripped = text.strip()
            if stripped.startswith("["):
                try:
                    parsed = json.loads(stripped)
                    if isinstance(parsed, list):
                        text = parsed
                except ValueError:
                    pass
            if isinstance(text, str):
                text = [text]

        max_file = getattr(settings, "MEDIA_MAX_FILE_BYTES", 50 * 1024 * 1024)
        max_total = getattr(
            settings, "MEDIA_MAX_TOTAL_PER_CAPTURE", 200 * 1024 * 1024
        )

        def _attached(kind: str) -> dict[int, object]:
            """File parts for one kind, keyed by their index in the
            media JSON list (part name: ``file:<kind>:<index>``)."""
            if not files:
                return {}
            pattern = re.compile(rf"^file:{kind}:(\d+)$")
            attached = {}
            for name in files.keys():
                match = pattern.match(name)
                if match:
                    attached[int(match.group(1))] = files.get(name)
            return attached

        # Size gates, checked before anything is stored: a rejection
        # here means no capture row and no orphaned objects. ``image``
        # is the screenshot's part family (``file:image:<index>``): the
        # screenshot is a single item, but it obeys the same per-file
        # and per-capture caps as the media parts.
        total_size = 0
        for kind in ("image", "images", "videos", "audios"):
            for index, file in _attached(kind).items():
                if file.size > max_file:
                    raise serializers.ValidationError(
                        {
                            f"file:{kind}:{index}": (
                                f"exceeds the {max_file} byte per-file limit"
                            )
                        }
                    )
                total_size += file.size
        if total_size > max_total:
            raise serializers.ValidationError(
                {
                    "detail": (
                        f"media exceeds the {max_total} byte per-capture limit"
                    )
                }
            )

        # Build the instance first: its UUID (the storage prefix) exists
        # from construction, so attached files can be uploaded before the
        # row is inserted — a failed upload then leaves no row behind.
        capture = Capture(
            user=validated_data["user"],
            text_sources=text,
            source_url=validated_data.get("source_url"),
        )
        # to_internal_value always lands the merged value here (see
        # _merged_metadata): {} when the client sent neither metadata nor
        # eligible extra fields, the explicit object, the merged object,
        # or null.
        if "metadata" in validated_data:
            capture.metadata = validated_data["metadata"]
        capture_id = str(capture.capture_id)

        def _stored_name(kind: str, source_id: str, ext: str) -> str:
            return media_storage.media_object_path(capture_id, kind, source_id, ext)

        def _build_sources(kind: str) -> list[dict]:
            sources = []
            for index, item in enumerate(media.get(kind) or []):
                if not isinstance(item, dict):
                    continue
                url = (item.get("url") or "").strip()
                file = _attached(kind).get(index)
                if file is None and not url:
                    continue  # empty item: skip, as before
                source_id = item.get("id") or str(uuid.uuid4())
                if file is not None:
                    # The client collected the file: store it now, in the
                    # web process, and point the entry at the stored
                    # object. The worker's ingest step will skip it.
                    name = _stored_name(
                        kind,
                        source_id,
                        media_storage.extension_for(file.name, file.content_type),
                    )
                    media_storage.save_bytes(name, file.read())
                    sources.append(
                        {
                            "id": source_id,
                            "url": name,
                            "original_url": url or None,
                            # The client handed over the bytes: stored,
                            # assessed, done — the worker's ingest skips
                            # it (the status completes the
                            # downloaded/skipped/download_failed
                            # convention on stored items).
                            "status": "downloaded",
                        }
                    )
                else:
                    # Link-only item: as before. No original_url yet —
                    # that key marks "ingest has assessed this", so it
                    # stays unset for the worker to fill in.
                    sources.append({"id": source_id, "url": url})
            return sources

        image_sources = _build_sources("images")
        video_sources = _build_sources("videos")
        audio_sources = _build_sources("audios")

        image = data.get("image") or ""
        # The file-part carrier: ``file:image:0``. The screenshot is a
        # single item (the ``:0`` is the contract, not a list index), so
        # any ``file:image:<n>`` part present is taken as the screenshot
        # — a misnumbered part must never be silently dropped.
        attached_screenshots = _attached("image")
        screenshot_part = (
            attached_screenshots[min(attached_screenshots)]
            if attached_screenshots
            else None
        )

        screenshot = None
        if screenshot_part is not None:
            # A file part beats a data-URL string when both are present
            # (it is the better carrier); the string is then simply not
            # consulted.
            content_type = (
                (screenshot_part.content_type or "").split(";")[0].strip().lower()
            )
            if content_type not in ("image/png", "image/jpeg"):
                # A client that cannot supply a content type (or sends the
                # generic octet-stream) is judged by the filename instead:
                # a .png/.jpg/.jpeg name is still a plausible screenshot.
                name_ext = os.path.splitext(screenshot_part.name or "")[1].lower()
                if not (
                    content_type in ("", "application/octet-stream")
                    and name_ext in (".png", ".jpg", ".jpeg")
                ):
                    raise serializers.ValidationError(
                        {"image": "must be a PNG or JPEG image"}
                    )
            # Extension from the content type (mirrors the data-URL path,
            # which gets its extension from the data-URL's own prefix);
            # the filename is the fallback when the type was unknown.
            ext = media_storage.EXT_BY_CONTENT_TYPE.get(
                content_type,
                media_storage.extension_for(screenshot_part.name),
            )

            # The web process has the bytes in hand: the screenshot
            # uploads to the storage backend during this request (the
            # ImageField routes through the default backend — Supabase
            # when configured, local disk otherwise).
            screenshot = ContentFile(
                screenshot_part.read(), name=f"screenshot{ext}"
            )
        elif image:
            match = re.match(r"^data:image/(png|jpeg);base64,(.+)$", image)

            if not match:
                raise serializers.ValidationError("image: Invalid base64 format")
            ext = "jpg" if match.group(1) == "jpeg" else "png"

            try:
                image_bytes = base64.b64decode(match.group(2), validate=True)
            except Exception:
                raise serializers.ValidationError("image: Invalid base64 format")

            # The web process has the bytes in hand: the screenshot
            # uploads to the storage backend during this request (the
            # ImageField routes through the default backend — Supabase
            # when configured, local disk otherwise).
            screenshot = ContentFile(image_bytes, name=f"screenshot.{ext}")

        capture.image_sources = image_sources
        capture.video_sources = video_sources
        capture.audio_sources = audio_sources
        capture.screenshot = screenshot

        try:
            capture.save()
        except Exception as err:
            # Nothing durable may survive a failed create: remove whatever
            # landed in the bucket/local disk (everything is under the
            # capture's prefix), and report a clean 400.
            media_storage.cleanup_capture_media(capture_id)
            raise serializers.ValidationError(
                {"detail": f"Failed to store capture media: {err}"}
            ) from err

        return capture

    def validate_metadata(self, value):
        """metadata is a JSON *object* (or null): a list or scalar has no
        home there (the *_sources lists already have their own fields)."""
        if value is not None and not isinstance(value, dict):
            raise serializers.ValidationError(
                "metadata must be a JSON object (or null)."
            )
        return value

    def to_representation(self, instance):
        response = super().to_representation(instance)

        if "image_sources" in response:
            del response["image_sources"]
        if "video_sources" in response:
            del response["video_sources"]
        if "audio_sources" in response:
            del response["audio_sources"]
        if "text_sources" in response:
            del response["text_sources"]

        response["capture"] = "success"
        return response


class CaptureContextSerializer(serializers.ModelSerializer):
    class Meta:
        model = CaptureContext

        fields = [
            "capture_context_id",
            "capture_id",
            "user",
            "text_context",
            "image_context",
            "video_context",
            "audio_context",
            "summary_text",
            "created_at",
            "updated_at",
        ]

        read_only_fields = fields


class ChunkSerializer(serializers.Serializer):
    """One embedding row of a search result: what matched, and how well.

    `text` is a preview (truncated by the search helper); the full
    chunk text is retrievable from GET /capture-embedding/.
    """

    source_key = serializers.CharField()
    score = serializers.FloatField()
    text = serializers.CharField()


class SearchResultSerializer(serializers.Serializer):
    """A search hit: one capture, ranked, carrying all of its chunks
    (best-first). `score` is the capture's best-chunk cosine similarity
    (higher = more relevant; not a percentage)."""

    capture_id = serializers.UUIDField()
    rank = serializers.IntegerField()
    score = serializers.FloatField()
    summary_text = serializers.CharField(allow_null=True)
    created_at = serializers.DateTimeField(allow_null=True)
    chunks = ChunkSerializer(many=True)


class CaptureEmbeddingSerializer(serializers.ModelSerializer):
    # Metadata only — the vector (1536 floats ≈ 12KB of JSON) is for
    # Postgres, never for the client.

    class Meta:
        model = CaptureEmbedding

        fields = [
            "id",
            "source_key",
            "text",
            "embedding_model",
            "created_at",
        ]

        read_only_fields = fields
