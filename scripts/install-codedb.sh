#!/usr/bin/env bash
set -euo pipefail

CODEDB_VERSION="0.2.5840"
CODEDB_SHA256="f784c931b053031ca9928173828130c504f769c9e94bf5c2666ab71091747966"
DATA_HOME="${XDG_DATA_HOME:-${HOME:?HOME is required}/.local/share}"
INSTALL_DIR="${CODEDB_INSTALL_DIR:-$DATA_HOME/mcp-dev-bridge/bin}"
DEST="$INSTALL_DIR/codedb-v$CODEDB_VERSION"
URL="https://github.com/justrach/codedb/releases/download/v$CODEDB_VERSION/codedb-linux-x86_64"

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "CodeDB $CODEDB_VERSION bootstrap currently supports Linux x86_64 only" >&2
  exit 1
fi
command -v curl >/dev/null 2>&1 || { echo "curl is required to install CodeDB" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required to verify CodeDB" >&2; exit 1; }

verify() {
  local candidate="$1" version
  [ -x "$candidate" ] || return 1
  printf '%s  %s\n' "$CODEDB_SHA256" "$candidate" | sha256sum -c - >/dev/null 2>&1 || return 1
  version="$($candidate --version 2>/dev/null | head -n1)"
  [ "$version" = "codedb $CODEDB_VERSION" ]
}

if verify "$DEST"; then
  echo "CodeDB ready: $DEST"
  exit 0
fi

mkdir -p "$INSTALL_DIR"
tmp="$(mktemp "$INSTALL_DIR/.codedb.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

curl --fail --location --http1.1 --connect-timeout 20 --max-time 300 "$URL" -o "$tmp"
printf '%s  %s\n' "$CODEDB_SHA256" "$tmp" | sha256sum -c -
chmod 0755 "$tmp"
mv -f "$tmp" "$DEST"
trap - EXIT

verify "$DEST" || { echo "installed CodeDB failed verification: $DEST" >&2; exit 1; }
echo "CodeDB ready: $DEST"
