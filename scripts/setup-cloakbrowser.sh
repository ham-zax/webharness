#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BROWSER_FAST_DIR="$ROOT/providers/browser-fast"
PLAYWRIGHT="$BROWSER_FAST_DIR/node_modules/.bin/playwright-core"

if [ "$(uname -s)" != "Linux" ]; then
  echo "managed CloakBrowser setup targets Linux (x86_64 or arm64)" >&2
  exit 1
fi
[ -x "$PLAYWRIGHT" ] || {
  echo "browser-fast dependencies are missing; run npm --prefix $BROWSER_FAST_DIR ci --omit=dev first" >&2
  exit 1
}
command -v node >/dev/null 2>&1 || { echo "node is required for CloakBrowser" >&2; exit 1; }

if ! "$PLAYWRIGHT" install-deps chromium --dry-run; then
  "$PLAYWRIGHT" install-deps chromium
fi

# Downloads the signed binary into ~/.cloakbrowser (or CLOAKBROWSER_CACHE_DIR) once.
(
  cd "$BROWSER_FAST_DIR"
  node --input-type=module <<'NODE'
import { ensureBinary } from 'cloakbrowser';
const executable = await ensureBinary();
console.log(`CloakBrowser browser ready: ${executable}`);
NODE
)
