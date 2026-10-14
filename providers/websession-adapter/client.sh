#!/usr/bin/env bash
set -euo pipefail
umask 077

WH_HOME=${WH_HOME:-"$HOME/.wh"}
WH_WAIT=${WH_WAIT:-90}
WH_MAX_SECONDS=${WH_MAX_SECONDS:-280}

fail() { printf '%s\n' "$*" >&2; exit 1; }
valid_tool() { [[ $1 =~ ^[A-Za-z0-9._-]{1,128}$ ]] || fail 'invalid tool name'; }
if [[ ! $WH_WAIT =~ ^[0-9]{1,2}$ ]] || (( 10#$WH_WAIT > 90 )); then
  fail 'WH_WAIT must be 0..90'
fi
if [[ ! $WH_MAX_SECONDS =~ ^[0-9]{1,6}$ ]] || (( 10#$WH_MAX_SECONDS == 0 )); then
  fail 'WH_MAX_SECONDS must be a positive integer'
fi
wait_seconds=$((10#$WH_WAIT))
max_seconds=$((10#$WH_MAX_SECONDS))
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
response=$work/response
headers=$work/headers
: > "$work/empty-headers"
status_url=''
state=''
error=''
started=$SECONDS

load_access() {
  [[ -f $WH_HOME/cap && -f $WH_HOME/base ]] || fail 'run wh login <base-url> first'
  IFS= read -r capability < "$WH_HOME/cap" || true
  IFS= read -r base < "$WH_HOME/base" || true
  [[ ${capability:-} =~ ^[A-Za-z0-9_-]{43}$ ]] || fail 'invalid stored capability'
  [[ ${base:-} =~ ^https?://[^[:space:]]+$ ]] || fail 'invalid stored base URL'
  printf 'Authorization: Bearer %s\n' "$capability" > "$headers"
  unset capability
}

timeout() {
  printf 'timeout; status_url: %s\n' "${status_url:-unavailable; do not retry the call automatically}" >&2
  exit 3
}

request() {
  local url=$1 limit=$((wait_seconds + 5)) remaining code rc
  shift
  remaining=$((max_seconds - (SECONDS - started)))
  (( remaining > 0 )) || timeout
  (( limit <= remaining )) || limit=$remaining
  if code=$(curl -sS --max-time "$limit" --header "@$headers" \
    --header 'Accept: text/plain' --output "$response" --write-out '%{http_code}' "$@" "$url"); then
    [[ $code == 200 ]] || fail "HTTP $code: request rejected"
  else
    rc=$?
    (( rc != 28 )) || timeout
    fail "curl failed (exit $rc); do not retry a call automatically"
  fi
}

# Read only protocol headers. After result:, stream the untouched remainder.
result() {
  local line found=false
  state=''
  error=''
  exec 3< "$response"
  IFS= read -r line <&3 || true
  [[ $line == 'WEBSESSION-MCP-BRIDGE/1' ]] || { exec 3<&-; fail 'unexpected response'; }
  while IFS= read -r line <&3; do
    case $line in
      'state: '*) state=${line#state: } ;;
      'status_url: '*) status_url=${line#status_url: } ;;
      'error: '*) error=${line#error: } ;;
      'result:') found=true; break ;;
    esac
  done
  case $state in
    completed)
      [[ $found == true ]] || { exec 3<&-; fail 'completed response has no result'; }
      cat <&3
      exec 3<&-
      return 0 ;;
    queued|running) exec 3<&-; return 4 ;;
    unknown_outcome) exec 3<&-; printf 'unknown_outcome: do not retry; check the effect first\n' >&2; exit 2 ;;
    tool_failed|rejected|expired) exec 3<&-; fail "$state: ${error:-$state}" ;;
    *) exec 3<&-; fail "unexpected state: ${state:-missing}" ;;
  esac
}

fetch_status() {
  local headers=$work/empty-headers
  [[ $status_url =~ ^https?://[^[:space:]]+$ ]] || fail 'invalid status_url'
  request "${status_url}?wait=${wait_seconds}"
}

command=${1:-}
[[ $# -gt 0 ]] && shift
case $command in
  login)
    [[ $# == 1 ]] || fail 'usage: wh login <base-url>'
    base=${1%/}
    [[ $base =~ ^https?://[^[:space:]]+$ && $base != *'?'* && $base != *'#'* ]] || fail 'invalid base URL'
    capability=''
    IFS= read -r capability || true
    [[ $capability =~ ^[A-Za-z0-9_-]{43}$ ]] || fail 'invalid capability'
    mkdir -p -- "$WH_HOME"
    printf '%s\n' "$capability" > "$WH_HOME/cap"
    printf '%s\n' "$base" > "$WH_HOME/base"
    chmod 600 "$WH_HOME/cap" "$WH_HOME/base"
    unset capability
    load_access
    request "$base/v1/tools"
    count=0
    while IFS= read -r name || [[ -n $name ]]; do
      [[ -z $name ]] || ((count += 1))
    done < "$response"
    printf 'ok: %s tools\n' "$count" ;;
  tools|instructions)
    [[ $# == 0 ]] || fail "usage: wh $command"
    load_access
    request "$base/v1/$command"
    cat "$response" ;;
  schema)
    [[ $# == 1 ]] || fail 'usage: wh schema <tool>'
    valid_tool "$1"
    load_access
    request "$base/v1/tools/$1"
    cat "$response" ;;
  call)
    [[ $# == 1 || $# == 2 ]] || fail 'usage: wh call <tool> [<json-arguments> | @file | -]'
    valid_tool "$1"
    load_access
    printf '{"version":1,"tool":"%s","arguments":' "$1" > "$work/request"
    arguments=${2:-'{}'}
    case $arguments in
      -) cat >> "$work/request" ;;
      @*) cat -- "${arguments#@}" >> "$work/request" ;;
      *) printf '%s' "$arguments" >> "$work/request" ;;
    esac
    printf '}' >> "$work/request"
    if [[ -r /proc/sys/kernel/random/uuid ]]; then
      IFS= read -r nonce < /proc/sys/kernel/random/uuid
    else
      nonce="$(date +%s)-$RANDOM-$RANDOM"
    fi
    [[ $nonce =~ ^[A-Za-z0-9._-]{1,64}$ ]] || fail 'invalid generated idempotency key'
    request "$base/v1/calls?wait=$wait_seconds" --header 'Content-Type: application/json' \
      --header "Idempotency-Key: $nonce" --data-binary "@$work/request"
    while true; do
      if result; then break; else rc=$?; fi
      (( rc == 4 )) || exit "$rc"
      fetch_status
    done ;;
  status)
    [[ $# == 1 ]] || fail 'usage: wh status <status_url>'
    status_url=$1
    # Status URLs already carry their continuation token; no login is required.
    : > "$headers"
    fetch_status
    if result; then exit 0; else rc=$?; fi
    (( rc != 4 )) || timeout
    exit "$rc" ;;
  *) fail 'usage: wh login|tools|instructions|schema|call|status' ;;
esac
