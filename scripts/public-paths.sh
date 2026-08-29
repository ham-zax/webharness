#!/usr/bin/env bash

# Shared public-distribution classifier. tests/publication.sh and
# scripts/stage-public.sh must consume this exact decision.
is_public_path() {
  case "$1" in
    docs/history/* | \
    docs/benchmarks/* | \
    experiments/* | \
    extensions/* | \
    skills/* | \
    bin/adapter | \
    bin/websession-call | \
    providers/websession-adapter/* | \
    docs/websession-clients.md | \
    docs/websession-master-bearer.md | \
    docs/migration-from-local-bridge.md | \
    tests/adapter-probe.sh | \
    scripts/export-personal-wsl-state.sh | \
    scripts/import-personal-wsl-state.sh | \
    docs/personal/wsl-migration.md | \
    timer-ping-test.log)
      return 1
      ;;
    docs/superpowers/plans/2026-08-29-webharness-agents-implementation.md | \
    third_party/chat-on-steroids-extension/*)
      return 0
      ;;
    docs/superpowers/*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

public_tracked_files() {
  local root="$1" path
  git -C "$root" ls-files | while IFS= read -r path; do
    is_public_path "$path" || continue
    printf '%s\n' "$path"
  done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  public_tracked_files "$ROOT"
fi
