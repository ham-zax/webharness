#!/usr/bin/env bash
set -euo pipefail
umask 077

WH_HOME=${WH_HOME:-"$HOME/.wh"}
WH_WAIT=${WH_WAIT:-90}
WH_MAX_SECONDS=${WH_MAX_SECONDS:-280}
WH_MAX_OUTPUT=${WH_MAX_OUTPUT:-8192}
WH_SH_TOOL=${WH_SH_TOOL:-dev_1mcp_bash}

fail() { printf '%s\n' "$*" >&2; exit 1; }
valid_tool() { [[ $1 =~ ^[A-Za-z0-9._-]{1,128}$ ]] || fail 'invalid tool name'; }
if [[ ! $WH_WAIT =~ ^[0-9]{1,2}$ ]] || (( 10#$WH_WAIT > 90 )); then
  fail 'WH_WAIT must be 0..90'
fi
if [[ ! $WH_MAX_SECONDS =~ ^[0-9]{1,6}$ ]] || (( 10#$WH_MAX_SECONDS == 0 )); then
  fail 'WH_MAX_SECONDS must be a positive integer'
fi
[[ $WH_MAX_OUTPUT =~ ^[0-9]{1,9}$ ]] || fail 'WH_MAX_OUTPUT must be a byte count (0 prints everything)'
wait_seconds=$((10#$WH_WAIT))
max_output=$((10#$WH_MAX_OUTPUT))
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
    [[ $code == 200 ]] || fail "HTTP $code: $(head -c 600 -- "$response" | tr -d '\r\n')"
  else
    rc=$?
    (( rc != 28 )) || timeout
    fail "curl failed (exit $rc); do not retry a call automatically"
  fi
}

# Print a result untouched when it fits. A larger one keeps its head and tail and is saved in full.
emit() {
  local size head_bytes
  size=$(($(wc -c < "$1")))
  if (( max_output == 0 || size <= max_output )); then
    cat -- "$1"
    return 0
  fi
  mkdir -p -- "$WH_HOME"
  cp -- "$1" "$WH_HOME/last"
  head_bytes=$((max_output * 3 / 4))
  head -c "$head_bytes" -- "$1"
  printf '\n[wh: %s of %s bytes shown, middle omitted; full output: %s; WH_MAX_OUTPUT=0 prints everything]\n' \
    "$max_output" "$size" "$WH_HOME/last"
  tail -c "$((max_output - head_bytes))" -- "$1"
}

json_string() {
  local value=$1 backslash quote='"' code char escaped
  printf -v backslash '%b' '\x5c'
  value=${value//"$backslash"/"$backslash$backslash"}
  value=${value//"$quote"/"$backslash$quote"}
  value=${value//$'\n'/"${backslash}n"}
  value=${value//$'\r'/"${backslash}r"}
  value=${value//$'\t'/"${backslash}t"}
  for code in 01 02 03 04 05 06 07 08 0b 0c 0e 0f 10 11 12 13 14 15 16 17 18 19 1a 1b 1c 1d 1e 1f 7f; do
    printf -v char '%b' "\\x$code"
    [[ $value == *"$char"* ]] || continue
    escaped="${backslash}u00$code"
    value=${value//"$char"/"$escaped"}
  done
  printf '"%s"' "$value"
}

# Read only protocol headers. After result:, keep the untouched remainder.
result() {
  local line rest found=false
  state=''
  error=''
  exec 3< "$response"
  IFS= read -r line <&3 || true
  [[ $line == 'WEBSESSION-MCP-BRIDGE/1' ]] || { exec 3<&-; fail 'unexpected response'; }
  while IFS= read -r line <&3 || [[ -n $line ]]; do
    case $line in
      'state: '*) state=${line#state: } ;;
      'status_url: '*) status_url=${line#status_url: } ;;
      'error: '*)
        # The error is the last header and may span several lines.
        error=${line#error: }
        while IFS= read -r rest <&3 || [[ -n $rest ]]; do error+=$'\n'$rest; done
        break ;;
      'result:') found=true; break ;;
    esac
  done
  case $state in
    completed)
      [[ $found == true ]] || { exec 3<&-; fail 'completed response has no result'; }
      cat <&3 > "$work/result"
      exec 3<&-
      emit "$work/result"
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
    if [[ $command == tools ]]; then request "$base/v1/signatures"; else request "$base/v1/instructions"; fi
    cat "$response" ;;
  schema)
    [[ $# == 1 ]] || fail 'usage: wh schema <tool>'
    valid_tool "$1"
    load_access
    request "$base/v1/tools/$1"
    cat "$response" ;;
  call|sh)
    if [[ $command == sh ]]; then
      # The script goes in as given (arguments or stdin), so it needs no JSON quoting.
      tool=$WH_SH_TOOL
      if [[ $# == 0 || ( $# == 1 && $1 == - ) ]]; then script=$(cat); else script=$*; fi
      [[ -n $script ]] || fail "usage: wh sh '<script>'  (or pass the script on stdin)"
      arguments="{\"command\":$(json_string "$script")}"
    else
      [[ $# == 1 || $# == 2 ]] || fail 'usage: wh call <tool> [<json-arguments> | @file | -]'
      tool=$1
      arguments=${2:-'{}'}
    fi
    valid_tool "$tool"
    load_access
    printf '{"version":1,"tool":"%s","arguments":' "$tool" > "$work/request"
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
  *) fail 'usage: wh login|tools|instructions|schema|sh|call|status' ;;
esac
