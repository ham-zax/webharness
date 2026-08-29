#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
[ -n "$USER_HOME" ] || { echo "unable to determine user home directory" >&2; exit 1; }

SOURCE="$ROOT/webharness-agents-extension"
TARGET="${WEBHARNESS_AGENTS_EXTENSION_DIR:-$USER_HOME/.local/share/webharness/agents-extension}"
PARENT="$(dirname "$TARGET")"
NAME="$(basename "$TARGET")"
TMP="$PARENT/.${NAME}.tmp.$$"
BACKUP="$PARENT/.${NAME}.old.$$"

[ -f "$SOURCE/manifest.json" ] || { echo "missing WebHarness Agents extension source: $SOURCE" >&2; exit 1; }
mkdir -p "$PARENT"
rm -rf "$TMP" "$BACKUP"
mkdir "$TMP"
cleanup() { rm -rf "$TMP" "$BACKUP"; }
trap cleanup EXIT
cp -a "$SOURCE/." "$TMP/"

if [ -e "$TARGET" ]; then
  mv "$TARGET" "$BACKUP"
fi
if ! mv "$TMP" "$TARGET"; then
  [ ! -e "$BACKUP" ] || mv "$BACKUP" "$TARGET"
  exit 1
fi
rm -rf "$BACKUP"
trap - EXIT

VERSION="$(node -e 'const m=require(process.argv[1]); process.stdout.write(String(m.version || "unknown"))' "$TARGET/manifest.json")"
echo "installed WebHarness Agents extension v$VERSION"
echo "  source: $SOURCE"
echo "  unpacked path: $TARGET"
echo "Chrome must load this unpacked path; restart/reload the dedicated Agents Chrome after an update."
