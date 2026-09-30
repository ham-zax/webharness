#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Running harness integration suite ==="
bash "$ROOT/tests/harness.sh"

echo "=== Running publication suite ==="
bash "$ROOT/tests/publication.sh"

echo "=== Running lifecycle suite ==="
bash "$ROOT/tests/lifecycle.sh"

echo "=== Running runtime lifecycle unit tests ==="
node --test "$ROOT"/lib/test/*.test.mjs "$ROOT"/lib/bridge/test/*.test.mjs

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

echo "=== Checking Skill snapshot ==="
if [ -f "$ROOT/skills/SNAPSHOT_SHA256.txt" ]; then
  bash "$ROOT/scripts/skill-snapshot.sh" check
fi

echo "=== Checking bash syntax ==="
for file in "$ROOT"/bin/* "$ROOT"/lib/bridge/*.sh "$ROOT"/scripts/*.sh "$ROOT"/tests/*.sh; do
  if [[ "$(head -n 1 "$file")" == *node* ]]; then continue; fi
  bash -n "$file"
done

echo "=== Checking JavaScript/ESM syntax ==="
node --check "$ROOT/bin/websession-call"
while IFS= read -r -d '' file; do
  node --check "$file"
done < <(find "$ROOT/scripts" "$ROOT/lib" "$ROOT/providers" \
  -type d \( -name node_modules -o -name vendor -o -name .venv \) -prune -o \
  -type f \( -name '*.mjs' -o -name '*.cjs' -o -name '*.js' \) -print0)

echo "=== Checking git diff for whitespace errors ==="
git -C "$ROOT" diff --check

echo "All tests passed successfully!"
