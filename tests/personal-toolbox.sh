#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKER="$ROOT/scripts/check-personal-toolbox.sh"
SETUP="$ROOT/scripts/setup-personal-toolbox.sh"
FAILURES=0
TESTS=0

pass() { printf 'ok - %s\n' "$1"; }
fail() { printf 'not ok - %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
run_test() {
  local name="$1"
  shift
  TESTS=$((TESTS + 1))
  if "$@"; then
    pass "$name"
  else
    fail "$name"
  fi
}

make_stub() {
  local dir="$1" name="$2" output="$3"
  cat > "$dir/$name" <<EOF
#!/usr/bin/env sh
printf '%s\\n' '$output'
EOF
  chmod +x "$dir/$name"
}

make_complete_toolbox() {
  local dir="$1"
  mkdir -p "$dir"
  make_stub "$dir" git 'git version 2.43.0'
  make_stub "$dir" rg 'ripgrep 14.1.0'
  make_stub "$dir" jq 'jq-1.7'
  make_stub "$dir" sed 'sed (GNU sed) 4.9'
  make_stub "$dir" awk 'GNU Awk 5.2.1'
  make_stub "$dir" grep 'grep (GNU grep) 3.11'
  make_stub "$dir" find 'find (GNU findutils) 4.9.0'
  make_stub "$dir" node 'v24.19.0'
  make_stub "$dir" npm '12.0.2'
  make_stub "$dir" pnpm '11.21.0'
  make_stub "$dir" corepack '0.35.0'
  make_stub "$dir" python3 'Python 3.12.3'
  make_stub "$dir" uv 'uv 0.11.18 (x86_64-unknown-linux-gnu)'
  make_stub "$dir" systemctl 'systemd 255 (255.4)'
  make_stub "$dir" journalctl 'systemd 255 (255.4)'
  make_stub "$dir" tmux 'tmux 3.4'
  make_stub "$dir" fd 'fd 10.4.1'
  make_stub "$dir" bat 'bat 0.26.1'
  make_stub "$dir" ast-grep 'ast-grep 0.45.0'
}

capture() {
  local output_file="$1"
  shift
  "$@" >"$output_file" 2>&1
}

contains() {
  local file="$1" text="$2"
  grep -Fq -- "$text" "$file"
}

test_checker_reports_complete_matrix() {
  local tmp out rc
  tmp="$(mktemp -d)" || return 1
  out="$tmp/out"
  make_complete_toolbox "$tmp/bin"
  PERSONAL_TOOLBOX_PATH="$tmp/bin" capture "$out" bash "$CHECKER"
  rc=$?
  if [ "$rc" -ne 0 ] ||
     ! contains "$out" 'OK required git | git version 2.43.0' ||
     ! contains "$out" 'OK required corepack | 0.35.0' ||
     ! contains "$out" 'OK required ast-grep | ast-grep 0.45.0' ||
     ! contains "$out" 'OK optional fd | fd 10.4.1' ||
     ! contains "$out" 'OK optional bat | bat 0.26.1' ||
     ! contains "$out" 'SUMMARY required_missing=0 required_invalid=0 optional_missing=0 optional_invalid=0'; then
    cat "$out"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

test_checker_fails_for_missing_required_tool() {
  local tmp out rc
  tmp="$(mktemp -d)" || return 1
  out="$tmp/out"
  make_complete_toolbox "$tmp/bin"
  rm "$tmp/bin/pnpm"
  PERSONAL_TOOLBOX_PATH="$tmp/bin" capture "$out" bash "$CHECKER"
  rc=$?
  if [ "$rc" -eq 0 ] || ! contains "$out" 'MISSING required pnpm'; then
    cat "$out"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

test_checker_reports_optional_gaps_without_failing() {
  local tmp out rc
  tmp="$(mktemp -d)" || return 1
  out="$tmp/out"
  make_complete_toolbox "$tmp/bin"
  rm "$tmp/bin/fd" "$tmp/bin/bat"
  PERSONAL_TOOLBOX_PATH="$tmp/bin" capture "$out" bash "$CHECKER"
  rc=$?
  if [ "$rc" -ne 0 ] ||
     ! contains "$out" 'MISSING optional fd' ||
     ! contains "$out" 'MISSING optional bat' ||
     ! contains "$out" 'SUMMARY required_missing=0 required_invalid=0 optional_missing=2 optional_invalid=0'; then
    cat "$out"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

test_checker_never_accepts_shadow_sg_as_ast_grep() {
  local tmp out rc
  tmp="$(mktemp -d)" || return 1
  out="$tmp/out"
  make_complete_toolbox "$tmp/bin"
  rm "$tmp/bin/ast-grep"
  make_stub "$tmp/bin" sg 'Usage: sg group [[-c] command]'
  PERSONAL_TOOLBOX_PATH="$tmp/bin" capture "$out" bash "$CHECKER"
  rc=$?
  if [ "$rc" -eq 0 ] || ! contains "$out" 'MISSING required ast-grep'; then
    cat "$out"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

test_checker_enforces_node_and_ast_grep_versions() {
  local tmp out rc
  tmp="$(mktemp -d)" || return 1
  out="$tmp/out"
  make_complete_toolbox "$tmp/bin"
  make_stub "$tmp/bin" node 'v20.18.0'
  make_stub "$tmp/bin" ast-grep 'ast-grep 0.44.0'
  PERSONAL_TOOLBOX_PATH="$tmp/bin" capture "$out" bash "$CHECKER"
  rc=$?
  if [ "$rc" -eq 0 ] ||
     ! contains "$out" 'INVALID required node | v20.18.0 | need >= 24.0.0' ||
     ! contains "$out" 'INVALID required ast-grep | ast-grep 0.44.0 | need = 0.45.0'; then
    cat "$out"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

test_setup_dry_run_uses_pinned_user_level_installers() {
  local tmp out rc
  tmp="$(mktemp -d)" || return 1
  out="$tmp/out"
  make_complete_toolbox "$tmp/bin"
  rm "$tmp/bin/pnpm" "$tmp/bin/ast-grep"
  HOME="$tmp/home" PERSONAL_TOOLBOX_PATH="$tmp/bin" capture "$out" bash "$SETUP" --dry-run
  rc=$?
  if [ "$rc" -ne 0 ] ||
     ! contains "$out" 'PLAN pnpm | corepack install --global pnpm@11.21.0; corepack enable pnpm' ||
     ! contains "$out" "PLAN ast-grep | npm install --global --prefix $tmp/home/.local --allow-scripts=@ast-grep/cli @ast-grep/cli@0.45.0"; then
    cat "$out"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

test_setup_leaves_present_unqualified_non_ast_tools_untouched() {
  local tmp out rc
  tmp="$(mktemp -d)" || return 1
  out="$tmp/out"
  make_complete_toolbox "$tmp/bin"
  make_stub "$tmp/bin" tmux 'tmux 3.3a'
  cat > "$tmp/bin/pnpm" <<'EOF'
#!/usr/bin/env sh
printf '%s\n' 'pnpm probe failed' >&2
exit 1
EOF
  chmod +x "$tmp/bin/pnpm"
  HOME="$tmp/home" PERSONAL_TOOLBOX_PATH="$tmp/bin" capture "$out" bash "$SETUP" --dry-run
  rc=$?
  if [ "$rc" -ne 2 ] ||
     ! contains "$out" 'tmux (INVALID)' ||
     ! contains "$out" 'pnpm (INVALID)' ||
     contains "$out" 'PLAN pnpm |' ||
     contains "$out" 'PLAN apt |' ; then
    cat "$out"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

test_setup_refuses_python_override_for_missing_uv() {
  local tmp out rc
  tmp="$(mktemp -d)" || return 1
  out="$tmp/out"
  make_complete_toolbox "$tmp/bin"
  rm "$tmp/bin/uv"
  HOME="$tmp/home" PERSONAL_TOOLBOX_PATH="$tmp/bin" capture "$out" bash "$SETUP" --dry-run
  rc=$?
  if [ "$rc" -ne 2 ] ||
     ! contains "$out" 'MANUAL required prerequisite(s) left untouched: uv (MISSING)' ||
     contains "$out" 'PLAN uv |'; then
    cat "$out"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

test_setup_is_noop_when_toolbox_is_complete() {
  local tmp out1 out2 rc1 rc2
  tmp="$(mktemp -d)" || return 1
  out1="$tmp/out1"
  out2="$tmp/out2"
  make_complete_toolbox "$tmp/bin"
  PERSONAL_TOOLBOX_PATH="$tmp/bin" capture "$out1" bash "$SETUP" --dry-run
  rc1=$?
  PERSONAL_TOOLBOX_PATH="$tmp/bin" capture "$out2" bash "$SETUP" --dry-run
  rc2=$?
  if [ "$rc1" -ne 0 ] || [ "$rc2" -ne 0 ] ||
     ! contains "$out1" 'No toolbox changes needed.' ||
     ! cmp -s "$out1" "$out2"; then
    cat "$out1"
    cat "$out2"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

run_test 'checker reports required/optional tools with versions' test_checker_reports_complete_matrix
run_test 'checker fails for a missing required tool' test_checker_fails_for_missing_required_tool
run_test 'checker reports optional gaps without failing' test_checker_reports_optional_gaps_without_failing
run_test 'checker does not confuse shadow sg with ast-grep' test_checker_never_accepts_shadow_sg_as_ast_grep
run_test 'checker enforces Node and ast-grep qualification versions' test_checker_enforces_node_and_ast_grep_versions
run_test 'setup dry-run pins user-level installers and scopes ast-grep install scripts' test_setup_dry_run_uses_pinned_user_level_installers
run_test 'setup leaves present unqualified non-ast tools untouched' test_setup_leaves_present_unqualified_non_ast_tools_untouched
run_test 'setup refuses to bypass Python packaging policy for missing uv' test_setup_refuses_python_override_for_missing_uv
run_test 'setup is an idempotent no-op when the toolbox is complete' test_setup_is_noop_when_toolbox_is_complete

printf '\n%d tests, %d failures\n' "$TESTS" "$FAILURES"
[ "$FAILURES" -eq 0 ]
