#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FROM_CONFIG_DIR=""
STATE_DIR=""

usage() {
  cat <<'USAGE'
Usage: scripts/migrate-legacy-oauth-state.sh --from-config-dir PATH [--state-dir PATH]

Copies active inbound 1MCP OAuth continuity state from an existing legacy
--config-dir into the generated external 1MCP state home.

Migrated:
  session_cli_*.json   dynamic OAuth client registrations
  session_sess-*.json active Bearer-token sessions

Not migrated:
  auth_code_* / auth_request_*        short-lived authorization flow state
  streamable_session_*                transient MCP transport sessions
  client-side upstream OAuth sessions separate from ChatGPT inbound OAuth

The destination is never overwritten on conflict. Re-running the command is safe
when existing destination records are byte-identical.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --from-config-dir)
      [ "$#" -ge 2 ] || { echo "missing value for --from-config-dir" >&2; exit 2; }
      FROM_CONFIG_DIR="$2"
      shift 2
      ;;
    --state-dir)
      [ "$#" -ge 2 ] || { echo "missing value for --state-dir" >&2; exit 2; }
      STATE_DIR="$2"
      shift 2
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

[ -n "$FROM_CONFIG_DIR" ] || { echo "--from-config-dir is required" >&2; usage >&2; exit 2; }
[ -d "$FROM_CONFIG_DIR" ] || { echo "legacy config directory does not exist: $FROM_CONFIG_DIR" >&2; exit 1; }

if [ -z "$STATE_DIR" ]; then
  if [ -n "${XDG_STATE_HOME:-}" ]; then
    STATE_DIR="$XDG_STATE_HOME/mcp-dev-bridge"
  elif [ -n "${HOME:-}" ]; then
    STATE_DIR="$HOME/.local/state/mcp-dev-bridge"
  else
    echo "HOME or XDG_STATE_HOME is required when --state-dir is omitted" >&2
    exit 1
  fi
fi

FROM_CONFIG_DIR="$(cd "$FROM_CONFIG_DIR" && pwd -P)"
STATE_DIR="$(node -e 'console.log(require("path").resolve(process.argv[1]))' "$STATE_DIR")"
ROOT_REAL="$(cd "$ROOT" && pwd -P)"

case "$STATE_DIR/" in
  "$ROOT_REAL/"*)
    echo "refusing OAuth migration into the Git checkout: $STATE_DIR" >&2
    exit 1
    ;;
esac

# The qualified 1MCP runtime derives sessionStoragePath=<config-dir>/sessions and
# FileStorageService stores server records under sessions/server, yielding
# <config-dir>/sessions/sessions/server. Accept the preceding layout as a
# compatibility fallback for an older/explicit session-storage arrangement.
SOURCE_SERVER=""
for candidate in \
  "$FROM_CONFIG_DIR/sessions/sessions/server" \
  "$FROM_CONFIG_DIR/sessions/server" \
  "$FROM_CONFIG_DIR/sessions"
do
  if [ -d "$candidate" ] && find "$candidate" -maxdepth 1 -type f \( -name 'session_cli_*.json' -o -name 'session_sess-*.json' \) -print -quit | grep -q .; then
    SOURCE_SERVER="$candidate"
    break
  fi
done

if [ -z "$SOURCE_SERVER" ]; then
  echo "No durable inbound OAuth state found under $FROM_CONFIG_DIR; nothing to migrate."
  exit 0
fi

DEST_SERVER="$STATE_DIR/1mcp/sessions/sessions/server"

node - "$SOURCE_SERVER" "$DEST_SERVER" "$STATE_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const [sourceDir, destDir, stateDir] = process.argv.slice(2);
const now = Date.now();
const durable = /^(session_cli_|session_sess-).+\.json$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const candidates = [];
let expired = 0;
for (const name of fs.readdirSync(sourceDir).sort()) {
  if (!durable.test(name)) continue;
  const src = path.join(sourceDir, name);
  const st = fs.lstatSync(src);
  if (!st.isFile() || st.isSymbolicLink()) fail(`refusing non-regular OAuth state file: ${src}`);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(src, 'utf8'));
  } catch (error) {
    fail(`invalid OAuth state JSON: ${src}: ${error.message}`);
  }
  if (typeof record.expires !== 'number') {
    fail(`OAuth state record has no numeric expires field: ${src}`);
  }
  if (record.expires <= now) {
    expired += 1;
    continue;
  }
  candidates.push({ name, src });
}

// Preflight every collision before creating/copying anything so a mismatch
// cannot leave a partially migrated destination.
if (fs.existsSync(destDir)) {
  for (const { name, src } of candidates) {
    const dst = path.join(destDir, name);
    if (!fs.existsSync(dst)) continue;
    const st = fs.lstatSync(dst);
    if (!st.isFile() || st.isSymbolicLink()) fail(`refusing non-regular destination OAuth state: ${dst}`);
    if (!fs.readFileSync(src).equals(fs.readFileSync(dst))) {
      fail(`destination OAuth state conflicts with legacy record: ${dst}`);
    }
  }
}

const privateDirs = [
  stateDir,
  path.join(stateDir, '1mcp'),
  path.join(stateDir, '1mcp', 'sessions'),
  path.join(stateDir, '1mcp', 'sessions', 'sessions'),
  destDir,
];
for (const dir of privateDirs) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

let copied = 0;
let identical = 0;
for (const { name, src } of candidates) {
  const dst = path.join(destDir, name);
  if (fs.existsSync(dst)) {
    identical += 1;
    fs.chmodSync(dst, 0o600);
    continue;
  }
  try {
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dst, 0o600);
    copied += 1;
  } catch (error) {
    if (error.code === 'EEXIST' && fs.readFileSync(src).equals(fs.readFileSync(dst))) {
      fs.chmodSync(dst, 0o600);
      identical += 1;
      continue;
    }
    throw error;
  }
}

console.log(`OAuth migration complete: copied=${copied} existing_identical=${identical} expired_skipped=${expired}`);
console.log('Transient authorization and Streamable HTTP transport sessions were not migrated.');
NODE
