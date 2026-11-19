#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKER="$ROOT/scripts/check-personal-toolbox.sh"
SEARCH_PATH="${PERSONAL_TOOLBOX_PATH:-$PATH}"
USER_PREFIX="${PERSONAL_TOOLBOX_USER_PREFIX:-${HOME:?HOME is required}/.local}"
AST_GREP_VERSION="0.45.0"
PNPM_INSTALL_VERSION="11.21.0"
YQ_VERSION="v4.54.3"
PUEUE_VERSION="v4.0.5"
DIFFT_VERSION="0.72.0"
JUST_VERSION="1.59.0"
SCC_VERSION="v4.1.0"
HYPERFINE_VERSION="v2.0.0"
MCP_INSPECTOR_VERSION="2.16.0"
DRY_RUN=0
HEADLESS=0

usage() {
  cat <<'EOF'
Usage: scripts/setup-personal-toolbox.sh [--dry-run] [--headless]

Installs only missing approved Linux CLI tools. Existing Node, Git, Python,
and systemd installations are never globally upgraded. ast-grep is explicitly
qualified at 0.45.0 and is installed from the official @ast-grep/cli npm package.
Optional CLI accelerators (yq, pueue, pueued, difft, just, scc, hyperfine,
mcp-inspector, plus ast-grep/fd in --headless mode) are installed best-effort
into the user prefix and never fail bootstrap if unavailable on a host.

Options:
  --dry-run   Show the exact installation actions without changing the machine.
  --headless  Use the headless server matrix (required: git/rg/jq/node/tmux;
              optional: ast-grep/fd/yq/pueue/pueued/difft/just/scc/hyperfine/mcp-inspector).
  --help      Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --headless)
      HEADLESS=1
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

declare -a CHECKER_ARGS=()
if [ "$HEADLESS" -eq 1 ]; then
  CHECKER_ARGS+=(--headless)
fi

declare -A NEED_STATE=()
declare -A NEED_TIER=()

set +e
CHECK_OUTPUT="$(PERSONAL_TOOLBOX_PATH="$SEARCH_PATH" bash "$CHECKER" "${CHECKER_ARGS[@]}" 2>&1)"
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
declare -a OPTIONAL_APT_PACKAGES=()
declare -a MANUAL_BLOCKERS=()
declare -a OPTIONAL_BINARIES=()
need_pnpm=0
need_ast_grep=0
ast_grep_optional=0
need_fd_alias=0
need_bat_alias=0
need_mcp_inspector=0

add_unique() {
  local array_name="$1" value="$2" existing
  local -n target_ref="$array_name"
  for existing in "${target_ref[@]:-}"; do
    [ "$existing" = "$value" ] && return 0
  done
  target_ref+=("$value")
}

for name in "${!NEED_STATE[@]}"; do
  state="${NEED_STATE[$name]}"
  tier="${NEED_TIER[$name]}"
  case "$name:$state" in
    ast-grep:*)
      if [ "$tier" = required ]; then
        need_ast_grep=1
      elif [ "$state" = MISSING ]; then
        need_ast_grep=1
        ast_grep_optional=1
      else
        printf 'WARN optional %s exists but its version probe failed; leaving it untouched.\n' "$name"
      fi
      ;;
    pnpm:MISSING)
      need_pnpm=1
      ;;
    tmux:MISSING)
      add_unique APT_PACKAGES tmux
      ;;
    git:MISSING)
      add_unique APT_PACKAGES git
      ;;
    rg:MISSING)
      add_unique APT_PACKAGES ripgrep
      ;;
    jq:MISSING)
      add_unique APT_PACKAGES jq
      ;;
    sed:MISSING)
      add_unique APT_PACKAGES sed
      ;;
    awk:MISSING)
      add_unique APT_PACKAGES gawk
      ;;
    grep:MISSING)
      add_unique APT_PACKAGES grep
      ;;
    find:MISSING)
      add_unique APT_PACKAGES findutils
      ;;
    fd:MISSING)
      add_unique OPTIONAL_APT_PACKAGES fd-find
      need_fd_alias=1
      ;;
    bat:MISSING)
      add_unique OPTIONAL_APT_PACKAGES bat
      need_bat_alias=1
      ;;
    yq:MISSING|pueue:MISSING|pueued:MISSING|difft:MISSING|just:MISSING|scc:MISSING|hyperfine:MISSING)
      add_unique OPTIONAL_BINARIES "$name"
      ;;
    mcp-inspector:MISSING)
      need_mcp_inspector=1
      ;;
    fd:INVALID|bat:INVALID|yq:INVALID|pueue:INVALID|pueued:INVALID|difft:INVALID|just:INVALID|scc:INVALID|hyperfine:INVALID|mcp-inspector:INVALID)
      printf 'WARN optional %s exists but its version probe failed; leaving it untouched.\n' "$name"
      ;;
    node:*|npm:*|pnpm:INVALID|corepack:*|python3:*|uv:*|systemctl:*|journalctl:*|tmux:INVALID|git:INVALID|rg:INVALID|jq:INVALID|sed:INVALID|awk:INVALID|grep:INVALID|find:INVALID)
      if [ "$tier" = required ]; then
        MANUAL_BLOCKERS+=("$name ($state)")
      fi
      ;;
  esac
done

detect_arch_tokens() {
  local machine="${PERSONAL_TOOLBOX_ARCH:-$(uname -m)}"
  case "$machine" in
    x86_64|amd64)
      ARCH_RUST="x86_64"
      ARCH_GO="amd64"
      ARCH_SCC="x86_64"
      return 0
      ;;
    aarch64|arm64)
      ARCH_RUST="aarch64"
      ARCH_GO="arm64"
      ARCH_SCC="arm64"
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

install_github_binary_raw() {
  local name="$1" url="$2" tmp
  tmp="$(mktemp -d)"
  if curl -fsSL "$url" -o "$tmp/$name"; then
    install -m 0755 "$tmp/$name" "$USER_PREFIX/bin/$name"
    rm -rf "$tmp"
    return 0
  fi
  rm -rf "$tmp"
  return 1
}

install_github_binary_tarball() {
  local name="$1" url="$2" tmp found
  tmp="$(mktemp -d)"
  if curl -fsSL "$url" | tar -xz -C "$tmp"; then
    found="$(find "$tmp" -type f -name "$name" | head -n 1 || true)"
    if [ -n "$found" ]; then
      install -m 0755 "$found" "$USER_PREFIX/bin/$name"
      rm -rf "$tmp"
      return 0
    fi
  fi
  rm -rf "$tmp"
  return 1
}

install_optional_binary() {
  local name="$1" url="" kind=""
  if ! detect_arch_tokens; then
    printf 'WARN optional %s skipped (unsupported architecture %s).\n' "$name" "${PERSONAL_TOOLBOX_ARCH:-$(uname -m)}" >&2
    return 0
  fi
  case "$name" in
    yq)
      kind="raw"
      url="https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${ARCH_GO}"
      ;;
    pueue|pueued)
      kind="raw"
      url="https://github.com/Nukesor/pueue/releases/download/${PUEUE_VERSION}/${name}-${ARCH_RUST}-unknown-linux-musl"
      ;;
    difft)
      kind="tar"
      url="https://github.com/Wilfred/difftastic/releases/download/${DIFFT_VERSION}/difft-${DIFFT_VERSION}-${ARCH_RUST}-unknown-linux-gnu.tar.gz"
      ;;
    just)
      kind="tar"
      url="https://github.com/casey/just/releases/download/${JUST_VERSION}/just-${JUST_VERSION}-${ARCH_RUST}-unknown-linux-musl.tar.gz"
      ;;
    scc)
      kind="tar"
      url="https://github.com/boyter/scc/releases/download/${SCC_VERSION}/scc_Linux_${ARCH_SCC}.tar.gz"
      ;;
    hyperfine)
      kind="tar"
      url="https://github.com/sharkdp/hyperfine/releases/download/${HYPERFINE_VERSION}/hyperfine-${HYPERFINE_VERSION}-${ARCH_RUST}-unknown-linux-gnu.tar.gz"
      ;;
    *)
      return 0
      ;;
  esac

  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'PLAN optional %s | %s -> %s/bin/%s\n' "$name" "$url" "$USER_PREFIX" "$name"
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    printf 'WARN optional %s skipped (curl not found).\n' "$name" >&2
    return 0
  fi
  if [ "$kind" = "raw" ]; then
    if ! install_github_binary_raw "$name" "$url"; then
      printf 'WARN optional %s install failed from %s (continuing).\n' "$name" "$url" >&2
    fi
  else
    if ! install_github_binary_tarball "$name" "$url"; then
      printf 'WARN optional %s install failed from %s (continuing).\n' "$name" "$url" >&2
    fi
  fi
}

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
  elif [ "$ast_grep_optional" -eq 0 ]; then
    command -v npm >/dev/null 2>&1 || { echo "npm is required to install ast-grep" >&2; exit 1; }
  fi
fi

if [ "$need_mcp_inspector" -eq 1 ] && [ "$DRY_RUN" -eq 1 ]; then
  printf 'PLAN optional mcp-inspector | npm install --global --prefix %s @modelcontextprotocol/inspector@%s\n' "$USER_PREFIX" "$MCP_INSPECTOR_VERSION"
fi

if [ "${#APT_PACKAGES[@]}" -gt 0 ]; then
  printf 'PLAN apt | sudo apt-get update && sudo apt-get install -y --no-install-recommends'
  printf ' %s' "${APT_PACKAGES[@]}"
  printf '\n'
fi

if [ "${#OPTIONAL_APT_PACKAGES[@]}" -gt 0 ]; then
  printf 'PLAN optional-apt | sudo apt-get install -y --no-install-recommends'
  printf ' %s' "${OPTIONAL_APT_PACKAGES[@]}"
  printf '\n'
fi

if [ "${#OPTIONAL_BINARIES[@]}" -gt 0 ] && [ "$DRY_RUN" -eq 1 ]; then
  for name in "${OPTIONAL_BINARIES[@]}"; do
    install_optional_binary "$name"
  done
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

apt_updated=0
if [ "${#APT_PACKAGES[@]}" -gt 0 ]; then
  command -v sudo >/dev/null 2>&1 || { echo "sudo is required for missing distro packages" >&2; exit 1; }
  sudo apt-get update
  apt_updated=1
  sudo apt-get install -y --no-install-recommends "${APT_PACKAGES[@]}"
fi

if [ "${#OPTIONAL_APT_PACKAGES[@]}" -gt 0 ]; then
  if command -v sudo >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
    if [ "$apt_updated" -eq 0 ]; then
      sudo apt-get update || true
    fi
    sudo apt-get install -y --no-install-recommends "${OPTIONAL_APT_PACKAGES[@]}" || \
      printf 'WARN optional apt packages failed (%s); continuing.\n' "${OPTIONAL_APT_PACKAGES[*]}" >&2
  else
    printf 'WARN optional apt packages skipped (sudo/apt-get unavailable): %s\n' "${OPTIONAL_APT_PACKAGES[*]}" >&2
  fi
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
  if [ "$ast_grep_optional" -eq 1 ]; then
    if command -v npm >/dev/null 2>&1; then
      npm install --global --prefix "$USER_PREFIX" --allow-scripts=@ast-grep/cli "@ast-grep/cli@$AST_GREP_VERSION" || \
        printf 'WARN optional ast-grep install failed; continuing.\n' >&2
    else
      printf 'WARN optional ast-grep skipped (npm not found).\n' >&2
    fi
  else
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
fi

for name in "${OPTIONAL_BINARIES[@]:-}"; do
  [ -n "$name" ] && install_optional_binary "$name"
done

if [ "$need_mcp_inspector" -eq 1 ]; then
  if command -v npm >/dev/null 2>&1; then
    npm install --global --prefix "$USER_PREFIX" "@modelcontextprotocol/inspector@$MCP_INSPECTOR_VERSION" || \
      printf 'WARN optional mcp-inspector install failed; continuing.\n' >&2
  else
    printf 'WARN optional mcp-inspector skipped (npm not found).\n' >&2
  fi
fi

FINAL_PATH="$USER_PREFIX/bin:$SEARCH_PATH"
echo "== final toolbox check =="
PERSONAL_TOOLBOX_PATH="$FINAL_PATH" bash "$CHECKER" "${CHECKER_ARGS[@]}"

if [ "$CHECK_RC" -eq 0 ]; then
  echo "Toolbox remained qualified; no required tool replacement was needed."
else
  echo "Toolbox setup complete."
fi
