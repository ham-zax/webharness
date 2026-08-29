#!/usr/bin/env bash
set -uo pipefail

SEARCH_PATH="${PERSONAL_TOOLBOX_PATH:-$PATH}"
NODE_MIN_VERSION="24.0.0"
TMUX_MIN_VERSION="3.4.0"
AST_GREP_VERSION="0.45.0"

required_missing=0
required_invalid=0
optional_missing=0
optional_invalid=0

find_executable() {
  local name="$1" dir
  local -a dirs=()
  IFS=':' read -r -a dirs <<<"$SEARCH_PATH"
  for dir in "${dirs[@]}"; do
    [ -n "$dir" ] || dir='.'
    if [ -x "$dir/$name" ] && [ ! -d "$dir/$name" ]; then
      printf '%s\n' "$dir/$name"
      return 0
    fi
  done
  return 1
}

probe_version() {
  local name="$1" executable="$2"
  case "$name" in
    tmux) "$executable" -V 2>&1 ;;
    *) "$executable" --version 2>&1 ;;
  esac
}

first_line() {
  local text="$1"
  printf '%s\n' "${text%%$'\n'*}"
}

extract_semver() {
  local text="$1"
  if [[ "$text" =~ ([0-9]+)\.([0-9]+)(\.([0-9]+))? ]]; then
    printf '%s.%s.%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[4]:-0}"
    return 0
  fi
  return 1
}

version_ge() {
  local actual="$1" required="$2"
  local a1 a2 a3 r1 r2 r3
  IFS='.' read -r a1 a2 a3 <<<"$actual"
  IFS='.' read -r r1 r2 r3 <<<"$required"
  a3="${a3:-0}"
  r3="${r3:-0}"
  if ((10#$a1 > 10#$r1)); then return 0; fi
  if ((10#$a1 < 10#$r1)); then return 1; fi
  if ((10#$a2 > 10#$r2)); then return 0; fi
  if ((10#$a2 < 10#$r2)); then return 1; fi
  ((10#$a3 >= 10#$r3))
}

record_missing() {
  local tier="$1" name="$2"
  printf 'MISSING %s %s\n' "$tier" "$name"
  if [ "$tier" = required ]; then
    required_missing=$((required_missing + 1))
  else
    optional_missing=$((optional_missing + 1))
  fi
}

record_invalid() {
  local tier="$1" name="$2" observed="$3" need="$4"
  printf 'INVALID %s %s | %s | need %s\n' "$tier" "$name" "$observed" "$need"
  if [ "$tier" = required ]; then
    required_invalid=$((required_invalid + 1))
  else
    optional_invalid=$((optional_invalid + 1))
  fi
}

check_tool() {
  local tier="$1" name="$2" qualification="${3:-}"
  local executable output rc line parsed
  if ! executable="$(find_executable "$name")"; then
    record_missing "$tier" "$name"
    return
  fi

  output="$(probe_version "$name" "$executable")"
  rc=$?
  line="$(first_line "$output")"
  if [ "$rc" -ne 0 ] || [ -z "$line" ]; then
    record_invalid "$tier" "$name" "version probe failed (exit $rc)" 'working version probe'
    return
  fi

  case "$qualification" in
    node-min)
      if ! parsed="$(extract_semver "$line")" || ! version_ge "$parsed" "$NODE_MIN_VERSION"; then
        record_invalid "$tier" "$name" "$line" ">= $NODE_MIN_VERSION"
        return
      fi
      ;;
    tmux-min)
      if ! parsed="$(extract_semver "$line")" || ! version_ge "$parsed" "$TMUX_MIN_VERSION"; then
        record_invalid "$tier" "$name" "$line" ">= 3.4"
        return
      fi
      ;;
    ast-grep-exact)
      if [[ ! "$line" =~ ^ast-grep[[:space:]]+([0-9]+\.[0-9]+\.[0-9]+) ]] ||
         [ "${BASH_REMATCH[1]:-}" != "$AST_GREP_VERSION" ]; then
        record_invalid "$tier" "$name" "$line" "= $AST_GREP_VERSION"
        return
      fi
      ;;
  esac

  printf 'OK %s %s | %s\n' "$tier" "$name" "$line"
}

printf 'Personal Linux CLI toolbox\n'
printf 'Search path: %s\n' "$SEARCH_PATH"

check_tool required git
check_tool required rg
check_tool required jq
check_tool required sed
check_tool required awk
check_tool required grep
check_tool required find
check_tool required node node-min
check_tool required npm
check_tool required pnpm
check_tool required corepack
check_tool required python3
check_tool required uv
check_tool required systemctl
check_tool required journalctl
check_tool required tmux tmux-min
check_tool required ast-grep ast-grep-exact

check_tool optional fd
check_tool optional bat

printf 'SUMMARY required_missing=%d required_invalid=%d optional_missing=%d optional_invalid=%d\n' \
  "$required_missing" "$required_invalid" "$optional_missing" "$optional_invalid"

[ "$required_missing" -eq 0 ] && [ "$required_invalid" -eq 0 ]
