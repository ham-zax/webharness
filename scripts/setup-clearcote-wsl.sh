#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BROWSER_FAST_DIR="$ROOT/providers/browser-fast"
PLAYWRIGHT="$BROWSER_FAST_DIR/node_modules/.bin/playwright-core"

if [ "$(uname -s)" != "Linux" ] || ! grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  echo "managed Clearcote personal setup currently targets Linux under WSL" >&2
  exit 1
fi
if [ "$(uname -m)" != "x86_64" ]; then
  echo "Clearcote 0.27.0 personal setup currently requires WSL x86_64" >&2
  exit 1
fi
if [ -r /etc/os-release ]; then
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || { echo "managed Clearcote personal setup currently targets Ubuntu under WSL" >&2; exit 1; }
fi
[ -x "$PLAYWRIGHT" ] || {
  echo "browser-fast dependencies are missing; run npm --prefix $BROWSER_FAST_DIR ci --omit=dev first" >&2
  exit 1
}
command -v node >/dev/null 2>&1 || { echo "node is required for Clearcote" >&2; exit 1; }

if ! command -v xz >/dev/null 2>&1; then
  command -v sudo >/dev/null 2>&1 || { echo "sudo is required to install xz-utils" >&2; exit 1; }
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends xz-utils
fi

if ! "$PLAYWRIGHT" install-deps chromium --dry-run; then
  "$PLAYWRIGHT" install-deps chromium
fi

(
  cd "$BROWSER_FAST_DIR"
  node --input-type=module <<'NODE'
import { download } from 'clearcote';
const executable = await download({ quiet: true });
console.log(`Clearcote browser ready: ${executable}`);
NODE
)
