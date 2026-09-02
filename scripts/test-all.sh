#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Running harness integration suite ==="
bash "$ROOT/tests/harness.sh"

echo "=== Running publication suite ==="
bash "$ROOT/tests/publication.sh"

echo "=== Running lifecycle suite ==="
bash "$ROOT/tests/lifecycle.sh"

echo "=== Running provider unit tests ==="
for dir in "$ROOT"/providers/*; do
  if [ -f "$dir/package.json" ]; then
    name="$(basename "$dir")"
    echo "--- Testing provider: $name ---"
    (cd "$dir" && npm test)
  fi
done

echo "=== Checking documentation links ==="
node "$ROOT/scripts/check-doc-links.mjs"

echo "=== Checking bash syntax ==="
bash -n "$ROOT"/bin/* "$ROOT"/lib/bridge/*.sh "$ROOT"/scripts/*.sh "$ROOT"/tests/*.sh

echo "=== Checking JavaScript/ESM syntax ==="
node --check "$ROOT"/scripts/*.mjs \
  "$ROOT"/providers/pi-dev/*.mjs \
  "$ROOT"/providers/terminal/*.mjs \
  "$ROOT"/providers/code-router/*.mjs \
  "$ROOT"/providers/browser/*.mjs \
  "$ROOT"/providers/browser-fast/*.mjs \
  "$ROOT"/providers/local-tools/*.mjs

echo "=== Checking git diff for whitespace errors ==="
git -C "$ROOT" diff --check

echo "All tests passed successfully!"
