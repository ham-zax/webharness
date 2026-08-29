#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKER="$ROOT/scripts/check-personal-toolbox.sh"
SEARCH_PATH="${PERSONAL_TOOLBOX_PATH:-$PATH}"
USER_PREFIX="${PERSONAL_TOOLBOX_USER_PREFIX:-${HOME:?HOME is required}/.local}"
AST_GREP_VERSION="0.45.0"
PNPM_INSTALL_VERSION="11.21.0"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/setup-personal-toolbox.sh [--dry-run]

Installs only missing approved personal CLI tools. Existing Node, Git, Python,
and systemd installations are never globally upgraded. ast-grep is explicitly
qualified at 0.45.0 and is installed from the official @ast-grep/cli npm package.

Options:
  --dry-run  Show the exact installation actions without changing the machine.
  --help     Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
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

[ -f "$CHECKER" ] || { echo "missing toolbox checker: $CHECKER" >&2; exit 1; }

declare -A NEED_STATE=()
declare -A NEED_TIER=()

set +e
CHECK_OUTPUT="$(PERSONAL_TOOLBOX_PATH="$SEARCH_PATH" bash "$CHECKER" 2>&1)"
CHECK_RC=$?
set -e
printf '%s\n' "$CHECK_OUTPUT"

while IFS= read -r line; do
  case "$line" in
    MISSING\ required\ *|MISSING\ optional\ *|INVALID\ required\ *|INVALID\ optional\ *)
      state="${line%% *}"
      rest="${line#* }"
      tier="${rest%% *}"
      rest="${rest#* }"
      name="${rest%% *}"
      NEED_STATE["$name"]="$state"
      NEED_TIER["$name"]="$tier"
      ;;
  esac
done <<<"$CHECK_OUTPUT"

if [ "${#NEED_STATE[@]}" -eq 0 ]; then
  echo "No toolbox changes needed."
  exit 0
fi

declare -a APT_PACKAGES=()
declare -a MANUAL_BLOCKERS=()
need_pnpm=0
need_ast_grep=0
need_fd_alias=0
need_bat_alias=0

add_apt_package() {
  local package="$1" existing
  for existing in "${APT_PACKAGES[@]:-}"; do
    [ "$existing" = "$package" ] && return 0
  done
  APT_PACKAGES+=("$package")
}

for name in "${!NEED_STATE[@]}"; do
  state="${NEED_STATE[$name]}"
  tier="${NEED_TIER[$name]}"
  case "$name:$state" in
    ast-grep:*)
      need_ast_grep=1
      ;;
    pnpm:MISSING)
      need_pnpm=1
      ;;
    tmux:MISSING)
      add_apt_package tmux
      ;;
    git:MISSING)
      add_apt_package git
      ;;
    rg:MISSING)
      add_apt_package ripgrep
      ;;
    jq:MISSING)
      add_apt_package jq
      ;;
    sed:MISSING)
      add_apt_package sed
      ;;
    awk:MISSING)
      add_apt_package gawk
      ;;
    grep:MISSING)
      add_apt_package grep
      ;;
    find:MISSING)
      add_apt_package findutils
      ;;
    fd:MISSING)
      add_apt_package fd-find
      need_fd_alias=1
      ;;
    bat:MISSING)
      add_apt_package bat
      need_bat_alias=1
      ;;
    fd:INVALID|bat:INVALID)
      printf 'WARN optional %s exists but its version probe failed; leaving it untouched.\n' "$name"
      ;;
    node:*|npm:*|pnpm:INVALID|corepack:*|python3:*|uv:*|systemctl:*|journalctl:*|tmux:INVALID|git:INVALID|rg:INVALID|jq:INVALID|sed:INVALID|awk:INVALID|grep:INVALID|find:INVALID)
      if [ "$tier" = required ]; then
        MANUAL_BLOCKERS+=("$name ($state)")
      fi
      ;;
  esac
done

if [ "$need_pnpm" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'PLAN pnpm | corepack install --global pnpm@%s; corepack enable pnpm\n' "$PNPM_INSTALL_VERSION"
  else
    command -v corepack >/dev/null 2>&1 || { echo "corepack is required to install pnpm without changing Node" >&2; exit 1; }
  fi
fi

if [ "$need_ast_grep" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'PLAN ast-grep | npm install --global --prefix %s --allow-scripts=@ast-grep/cli @ast-grep/cli@%s\n' "$USER_PREFIX" "$AST_GREP_VERSION"
  else
    command -v npm >/dev/null 2>&1 || { echo "npm is required to install ast-grep" >&2; exit 1; }
  fi
fi

if [ "${#APT_PACKAGES[@]}" -gt 0 ]; then
  printf 'PLAN apt | sudo apt-get update && sudo apt-get install -y --no-install-recommends'
  printf ' %s' "${APT_PACKAGES[@]}"
  printf '\n'
fi

if [ "${#MANUAL_BLOCKERS[@]}" -gt 0 ]; then
  printf 'MANUAL required prerequisite(s) left untouched:' >&2
  printf ' %s' "${MANUAL_BLOCKERS[@]}" >&2
  printf '\n' >&2
  printf 'Refusing to globally replace or upgrade Node, Git, Python, systemd, or an unqualified existing system tool.\n' >&2
  exit 2
fi

if [ "$DRY_RUN" -eq 1 ]; then
  exit 0
fi

if [ "${#APT_PACKAGES[@]}" -gt 0 ]; then
  command -v sudo >/dev/null 2>&1 || { echo "sudo is required for missing distro packages" >&2; exit 1; }
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends "${APT_PACKAGES[@]}"
fi

mkdir -p "$USER_PREFIX/bin"

if [ "$need_fd_alias" -eq 1 ] && ! command -v fd >/dev/null 2>&1; then
  if command -v fdfind >/dev/null 2>&1; then
    ln -sfn "$(command -v fdfind)" "$USER_PREFIX/bin/fd"
  fi
fi

if [ "$need_bat_alias" -eq 1 ] && ! command -v bat >/dev/null 2>&1; then
  if command -v batcat >/dev/null 2>&1; then
    ln -sfn "$(command -v batcat)" "$USER_PREFIX/bin/bat"
  fi
fi

if [ "$need_pnpm" -eq 1 ]; then
  corepack install --global "pnpm@$PNPM_INSTALL_VERSION"
  corepack enable pnpm
fi

if [ "$need_ast_grep" -eq 1 ]; then
  npm install --global --prefix "$USER_PREFIX" --allow-scripts=@ast-grep/cli "@ast-grep/cli@$AST_GREP_VERSION"
  AST_GREP_BIN="$USER_PREFIX/bin/ast-grep"
  [ -x "$AST_GREP_BIN" ] || { echo "ast-grep install did not create $AST_GREP_BIN" >&2; exit 1; }
  AST_GREP_OUTPUT="$($AST_GREP_BIN --version 2>&1)"
  case "$AST_GREP_OUTPUT" in
    "ast-grep $AST_GREP_VERSION"*) ;;
    *)
      echo "unexpected ast-grep version after install: $AST_GREP_OUTPUT" >&2
      exit 1
      ;;
  esac
fi

FINAL_PATH="$USER_PREFIX/bin:$SEARCH_PATH"
echo "== final toolbox check =="
PERSONAL_TOOLBOX_PATH="$FINAL_PATH" bash "$CHECKER"

if [ "$CHECK_RC" -eq 0 ]; then
  echo "Toolbox remained qualified; no required tool replacement was needed."
else
  echo "Toolbox setup complete."
fi
