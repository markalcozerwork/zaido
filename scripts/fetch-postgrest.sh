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

mkdir -p "$DEST"
URL="https://github.com/PostgREST/postgrest/releases/download/${VERSION}/postgrest-${VERSION}-linux-static-x86-64.tar.xz"
curl -fsSL --retry 4 --retry-delay 2 "$URL" | tar -xJ -C "$DEST"
"$BIN" --version
