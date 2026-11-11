#!/usr/bin/env bash
set -euo pipefail

while IFS= read -r _inherited; do unset "$_inherited"; done < <(compgen -e | grep -E '^(MCP|BRIDGE)_' || true)
unset _inherited

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CPU_COUNT="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
if ! [[ "$CPU_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  CPU_COUNT=4
fi

# Heavy suites stay sequential on memory-constrained hosts. Parallelism is opt-in.
DEFAULT_SUITE_JOBS=1
SUITE_JOBS="${WEBMCP_TEST_JOBS:-$DEFAULT_SUITE_JOBS}"
if ! [[ "$SUITE_JOBS" =~ ^[1-9][0-9]*$ ]]; then
  echo "WEBMCP_TEST_JOBS must be a positive integer (got: $SUITE_JOBS)" >&2
  exit 2
fi

# Test files can each spawn providers and browsers, so bound their default too.
DEFAULT_TEST_CONCURRENCY=1
TEST_CONCURRENCY="${WEBMCP_TEST_CONCURRENCY:-$DEFAULT_TEST_CONCURRENCY}"
if ! [[ "$TEST_CONCURRENCY" =~ ^[1-9][0-9]*$ ]]; then
  echo "WEBMCP_TEST_CONCURRENCY must be a positive integer (got: $TEST_CONCURRENCY)" >&2
  exit 2
fi

DEFAULT_SYNTAX_JOBS=$(( CPU_COUNT > 6 ? 6 : CPU_COUNT ))
SYNTAX_JOBS="${WEBMCP_SYNTAX_JOBS:-$DEFAULT_SYNTAX_JOBS}"
if ! [[ "$SYNTAX_JOBS" =~ ^[1-9][0-9]*$ ]]; then
  echo "WEBMCP_SYNTAX_JOBS must be a positive integer (got: $SYNTAX_JOBS)" >&2
  exit 2
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/webharness-test-all.XXXXXX")"
declare -a ACTIVE_PIDS=()

cleanup() {
  local pid
  for pid in "${ACTIVE_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

run_lib_unit_tests() {
  node --test --test-concurrency="$TEST_CONCURRENCY" "$ROOT"/lib/test/*.test.mjs "$ROOT"/lib/bridge/test/*.test.mjs
}

run_provider_tests() {
  (cd "$1" && npm test -- --test-concurrency="$TEST_CONCURRENCY")
}

check_skill_snapshot() {
  node "$ROOT/providers/skill-library/cli.mjs" check
  if [ -f "$ROOT/skills/SNAPSHOT_SHA256.txt" ]; then
    bash "$ROOT/scripts/skill-snapshot.sh" check
  fi
}

check_js_syntax() {
  local -a js_files=()
  if [ -f "$ROOT/bin/websession-call" ]; then
    js_files+=("$ROOT/bin/websession-call")
  fi
  local file
  while IFS= read -r -d '' file; do
    js_files+=("$file")
  done < <(find "$ROOT/scripts" "$ROOT/lib" "$ROOT/providers" \
    -type d \( -name node_modules -o -name vendor -o -name .venv \) -prune -o \
    -type f \( -name '*.mjs' -o -name '*.cjs' -o -name '*.js' \) -print0)
  if (( ${#js_files[@]} > 0 )); then
    printf '%s\0' "${js_files[@]}" | xargs -0 -P "$SYNTAX_JOBS" -n 1 node --check
  fi
}

declare -a TASK_HEADERS=()
declare -a TASK_KINDS=()
declare -a TASK_ARGS=()
declare -a TASK_WEIGHTS=()
FIRST_PROVIDER_INDEX=-1

add_task() {
  TASK_HEADERS+=("$1")
  TASK_KINDS+=("$2")
  TASK_ARGS+=("$3")
  TASK_WEIGHTS+=("$4")
}

add_task "=== Running harness integration suite ===" "bash_script" "$ROOT/tests/harness.sh" 90
add_task "=== Running isolated smoke suite ===" "bash_script" "$ROOT/tests/smoke-local.sh" 60
add_task "=== Running publication suite ===" "bash_script" "$ROOT/tests/publication.sh" 50
add_task "=== Running lifecycle suite ===" "bash_script" "$ROOT/tests/lifecycle.sh" 100
add_task "=== Running runtime lifecycle unit tests ===" "lib_unit" "" 80

for dir in "$ROOT"/providers/*; do
  if [ -f "$dir/package.json" ]; then
    if (( FIRST_PROVIDER_INDEX == -1 )); then
      FIRST_PROVIDER_INDEX="${#TASK_HEADERS[@]}"
    fi
    name="$(basename "$dir")"
    weight=55
    case "$name" in
      websession-adapter) weight=95 ;;
      pi-dev) weight=92 ;;
      local-tools) weight=85 ;;
    esac
    add_task "--- Testing provider: $name ---" "provider" "$dir" "$weight"
  fi
done

add_task "=== Checking documentation links ===" "node_script" "$ROOT/scripts/check-doc-links.mjs" 20
add_task "=== Checking Skill snapshot ===" "skill_snapshot" "" 20
add_task "=== Checking JavaScript/ESM syntax ===" "js_syntax" "" 40

TOTAL_TASKS="${#TASK_HEADERS[@]}"
declare -a LAUNCH_ORDER=()
for (( i = 0; i < TOTAL_TASKS; i++ )); do
  LAUNCH_ORDER+=("$i")
done

# Schedule longest-running suites first so tail latency does not dominate wall time.
for (( i = 1; i < TOTAL_TASKS; i++ )); do
  key_idx="${LAUNCH_ORDER[$i]}"
  key_weight="${TASK_WEIGHTS[$key_idx]}"
  j=$(( i - 1 ))
  while (( j >= 0 )); do
    prev_idx="${LAUNCH_ORDER[$j]}"
    if (( TASK_WEIGHTS[prev_idx] >= key_weight )); then
      break
    fi
    LAUNCH_ORDER[j + 1]="$prev_idx"
    j=$(( j - 1 ))
  done
  LAUNCH_ORDER[j + 1]="$key_idx"
done

start_task() {
  local idx="$1"
  local kind="${TASK_KINDS[$idx]}"
  local arg="${TASK_ARGS[$idx]}"
  (
    set +e
    case "$kind" in
      bash_script) bash "$arg" ;;
      lib_unit) run_lib_unit_tests ;;
      provider) run_provider_tests "$arg" ;;
      node_script) node "$arg" ;;
      skill_snapshot) check_skill_snapshot ;;
      js_syntax) check_js_syntax ;;
      *) echo "unknown task kind: $kind" >&2; exit 2 ;;
    esac >"$WORK_DIR/$idx.log" 2>&1
    local rc=$?
    printf '%d\n' "$rc" >"$WORK_DIR/$idx.done.tmp"
    mv "$WORK_DIR/$idx.done.tmp" "$WORK_DIR/$idx.done"
    exit 0
  ) &
  ACTIVE_PIDS+=("$!")
}

NEXT_PRINT=0
OVERALL_RC=0
declare -a FAILED_SECTIONS=()

run_bash_syntax_inline() {
  echo "=== Checking bash syntax ==="
  local -a bash_files=()
  local file
  for file in "$ROOT"/bin/* "$ROOT"/lib/bridge/*.sh "$ROOT"/scripts/*.sh "$ROOT"/tests/*.sh; do
    [ -f "$file" ] || continue
    if [[ "$(head -n 1 "$file")" == *node* ]]; then continue; fi
    bash_files+=("$file")
  done
  for file in "${bash_files[@]}"; do
    if ! bash -n "$file"; then
      OVERALL_RC=1
      FAILED_SECTIONS+=("=== Checking bash syntax === ($file)")
    fi
  done
}

flush_ready_sections() {
  local rc
  while (( NEXT_PRINT < TOTAL_TASKS )) && [ -f "$WORK_DIR/$NEXT_PRINT.done" ]; do
    if (( NEXT_PRINT == FIRST_PROVIDER_INDEX )); then
      echo "=== Running provider unit tests ==="
    fi
    if [[ "${TASK_KINDS[$NEXT_PRINT]}" == "js_syntax" ]]; then
      run_bash_syntax_inline
    fi
    echo "${TASK_HEADERS[$NEXT_PRINT]}"
    cat "$WORK_DIR/$NEXT_PRINT.log"
    read -r rc <"$WORK_DIR/$NEXT_PRINT.done"
    if (( rc != 0 )); then
      OVERALL_RC=1
      FAILED_SECTIONS+=("${TASK_HEADERS[$NEXT_PRINT]} (exit $rc)")
    fi
    NEXT_PRINT=$(( NEXT_PRINT + 1 ))
  done
}

IN_FLIGHT=0
NEXT_LAUNCH=0

while (( NEXT_LAUNCH < TOTAL_TASKS || IN_FLIGHT > 0 )); do
  while (( NEXT_LAUNCH < TOTAL_TASKS && IN_FLIGHT < SUITE_JOBS )); do
    start_task "${LAUNCH_ORDER[$NEXT_LAUNCH]}"
    NEXT_LAUNCH=$(( NEXT_LAUNCH + 1 ))
    IN_FLIGHT=$(( IN_FLIGHT + 1 ))
  done
  if (( IN_FLIGHT > 0 )); then
    wait -n || true
    IN_FLIGHT=$(( IN_FLIGHT - 1 ))
    flush_ready_sections
  fi
done

flush_ready_sections

echo "=== Checking git diff for whitespace errors ==="
if ! git -C "$ROOT" diff --check; then
  OVERALL_RC=1
  FAILED_SECTIONS+=("=== Checking git diff for whitespace errors ===")
fi

if (( OVERALL_RC != 0 )); then
  echo "=== Test gate failed ===" >&2
  for item in "${FAILED_SECTIONS[@]}"; do
    echo "  FAILED: $item" >&2
  done
  exit 1
fi

echo "All tests passed successfully!"
