#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=public-paths.sh
source "$ROOT/scripts/public-paths.sh"

usage() {
  cat <<'EOF'
Usage: scripts/stage-public.sh --destination PATH

Replace the working tree contents of an existing independent public Git
repository with files classified as public from this checkout. The destination
.git directory is preserved and source Git history is never copied.
EOF
}

DEST=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --destination)
      [ "$#" -ge 2 ] || { echo "missing value for --destination" >&2; usage >&2; exit 2; }
      DEST="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ -n "$DEST" ] || { echo "--destination is required" >&2; usage >&2; exit 2; }
DEST="$(realpath -m "$DEST")"
[ "$DEST" != "$ROOT" ] || { echo "destination must not be the source repository" >&2; exit 1; }
[ -d "$DEST/.git" ] || { echo "destination must be an existing independent Git repository: $DEST" >&2; exit 1; }

if ! git -C "$DEST" diff --quiet || ! git -C "$DEST" diff --cached --quiet || \
   [ -n "$(git -C "$DEST" ls-files --others --exclude-standard)" ]; then
  echo "refusing to replace a dirty public destination: $DEST" >&2
  exit 1
fi

find "$DEST" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} +

while IFS= read -r path; do
  src="$ROOT/$path"
  [ -e "$src" ] || [ -L "$src" ] || { echo "classified public path is missing: $path" >&2; exit 1; }
  mkdir -p "$DEST/$(dirname "$path")"
  cp -a "$src" "$DEST/$path"
done < <(public_tracked_files "$ROOT")

printf 'staged public reference source in %s\n' "$DEST"
