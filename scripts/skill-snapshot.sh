#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/skills/SNAPSHOT_SHA256.txt"
MODE="${1:-check}"

snapshot() {
  git -C "$ROOT" ls-files -- skills \
    | grep -v '^skills/SNAPSHOT_SHA256\.txt$' \
    | LC_ALL=C sort \
    | while IFS= read -r file; do
        (cd "$ROOT" && sha256sum -- "$file")
      done
}

case "$MODE" in
  check)
    tmp="$(mktemp)"
    trap 'rm -f "$tmp"' EXIT
    snapshot >"$tmp"
    if ! cmp -s "$tmp" "$MANIFEST"; then
      echo "Skill snapshot manifest is stale. Regenerate with: bash scripts/skill-snapshot.sh write" >&2
      diff -u "$MANIFEST" "$tmp" || true
      exit 1
    fi
    ;;
  write)
    tmp="$(mktemp "$ROOT/skills/.SNAPSHOT_SHA256.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    snapshot >"$tmp"
    chmod 0644 "$tmp"
    mv "$tmp" "$MANIFEST"
    trap - EXIT
    ;;
  *)
    echo "usage: $0 [check|write]" >&2
    exit 2
    ;;
esac
