#!/usr/bin/env bash
# ------------------------------------------------------------------
# dev/manifest-dev.sh — build the load directory for the DEV variant
# of the extension (impl doc §3.2; Flag §6-17).
#
# Chrome loads `manifest.json` by name, so the load directory is a
# copy of `extension/` in which the committed dev manifest
# (`manifest.dev.json` — the local-origins twin of `manifest.json`,
# same committed `key`, so the same stable extension ID and the same
# backend CORS allowlist entry covers both) takes that name.
#
# The SaaS manifest is never modified by this script.
#
# Usage:
#   dev/manifest-dev.sh [LOAD_DIR]
#   (default LOAD_DIR: extension/.dev-load — gitignored)
#
# Env overrides, if your local stack runs on different ports:
#   IE_API_ORIGIN  backend origin   (standard: http://localhost:8080)
#   IE_VITE_ORIGIN vite dev origin  (standard: http://localhost:5173)
#
# Then in chrome://extensions (developer mode): Load unpacked →
# the directory this script prints.
# ------------------------------------------------------------------
set -euo pipefail

STD_API_ORIGIN="http://localhost:8080"
STD_VITE_ORIGIN="http://localhost:5173"
# The standard production origin (the pinned one in the committed
# manifest + the API_BASE_URL constant in background.js).
PROD_ORIGIN="https://internetexpedition.ajiteshtamrakar.com"

API_ORIGIN="${IE_API_ORIGIN:-$STD_API_ORIGIN}"
VITE_ORIGIN="${IE_VITE_ORIGIN:-$STD_VITE_ORIGIN}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/extension"
OUT="${1:-$SRC/.dev-load}"

if [ ! -f "$SRC/manifest.dev.json" ]; then
    echo "error: $SRC/manifest.dev.json not found" >&2
    exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"
# Copy the tree, skipping the load dir itself: it lives inside extension/
# by default, and a plain recursive copy would copy its own output.
OUT_BASE="$(basename "$OUT")"
(cd "$SRC" && tar cf - --exclude "$OUT_BASE" .) | (cd "$OUT" && tar xf -)

# Chrome reads manifest.json — swap in the dev variant.
rm -f "$OUT/manifest.json"
cp "$SRC/manifest.dev.json" "$OUT/manifest.json"

# In-place sed across BSD (macOS) and GNU sed.
sed_inplace() {
    if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi
}

# Substitute the standard local origins with the configured values.
#   $OUT/manifest.json: the backend origin (host_permissions) and the
#                       vite origin (the all_urls exclude_matches).
#   $OUT/background.js: the two per-manifest origin CONSTANTS — both
#                       carry the production origin in the committed
#                       file, and they must NOT converge locally (in dev
#                       the API and the website are on different ports):
#                       API_BASE_URL → the local backend origin,
#                       FRONTEND_ORIGIN → the local vite origin. Line
#                       addressing keeps the two substitutions apart.
sed_inplace \
    -e "s|$STD_API_ORIGIN|$API_ORIGIN|g" \
    -e "s|$STD_VITE_ORIGIN|$VITE_ORIGIN|g" \
    "$OUT/manifest.json"
sed_inplace \
    -e "/^const API_BASE_URL/s|$PROD_ORIGIN|$API_ORIGIN|" \
    -e "/^const FRONTEND_ORIGIN/s|$PROD_ORIGIN|$VITE_ORIGIN|" \
    "$OUT/background.js"

# Sanity: the load dir must now carry the local origins.
grep -q "$API_ORIGIN" "$OUT/background.js" || {
    echo "error: $OUT/background.js does not carry $API_ORIGIN after substitution" >&2
    exit 1
}
grep -q "$VITE_ORIGIN" "$OUT/background.js" || {
    echo "error: $OUT/background.js does not carry $VITE_ORIGIN after substitution" >&2
    exit 1
}
grep -q "$API_ORIGIN" "$OUT/manifest.json" || {
    echo "error: $OUT/manifest.json does not carry $API_ORIGIN after substitution" >&2
    exit 1
}
grep -q "$VITE_ORIGIN" "$OUT/manifest.json" || {
    echo "error: $OUT/manifest.json does not carry $VITE_ORIGIN after substitution" >&2
    exit 1
}

echo "dev load dir: $OUT"
echo "  api origin: $API_ORIGIN"
echo "  vite origin: $VITE_ORIGIN"
echo "Load it in chrome://extensions (developer mode) → Load unpacked → the dir above."
