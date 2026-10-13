#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Download the pinned PostgREST release used by the integration tests into
# .cache/postgrest/ (gitignored). Supabase runs PostgREST 13 in front of every
# project, so this is the same API layer production uses.
# -----------------------------------------------------------------------------
set -euo pipefail
VERSION="${POSTGREST_VERSION:-v13.0.7}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/.cache/postgrest"
BIN="$DEST/postgrest"

if [[ -x "$BIN" ]] && "$BIN" --version | grep -q "${VERSION#v}"; then
  echo "✔ PostgREST ${VERSION} already present"
  exit 0
fi

# sha256 of the release tarball, so CI never runs a binary that changed upstream.
declare -A SHA256=(
  [v13.0.7]=4153f81ccc40e7b735edc89cd84b49da25ba27eb37d57c7f6a82c9005a0b762b
)
EXPECTED="${POSTGREST_SHA256:-${SHA256[$VERSION]:-}}"
[[ -n "$EXPECTED" ]] || { echo "No checksum pinned for PostgREST $VERSION (set POSTGREST_SHA256)." >&2; exit 1; }

mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/PostgREST/postgrest/releases/download/${VERSION}/postgrest-${VERSION}-linux-static-x86-64.tar.xz"
curl -fsSL --retry 4 --retry-delay 2 -o "$TMP/postgrest.tar.xz" "$URL"
echo "$EXPECTED  $TMP/postgrest.tar.xz" | sha256sum -c --quiet -
tar -xJ -C "$DEST" -f "$TMP/postgrest.tar.xz"
"$BIN" --version
