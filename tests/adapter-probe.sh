#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
PORT="$((41000 + ($$ % 1000)))"
BASE="http://127.0.0.1:$PORT"

mkdir -p "$TMP/home" "$TMP/state" "$TMP/run"

adapter() {
  env \
    HOME="$TMP/home" \
    XDG_STATE_HOME="$TMP/state" \
    XDG_RUNTIME_DIR="$TMP/run" \
    WEBSESSION_ADAPTER_PORT="$PORT" \
    WEBSESSION_ADAPTER_PUBLIC_URL="$BASE" \
    "$ROOT/bin/adapter" "$@"
}

cleanup() {
  adapter stop >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

if grep -Eq 'websession-adapter|bin/adapter' "$ROOT/bin/start" "$ROOT/bin/stop" "$ROOT/bin/status" "$ROOT/lib/bridge/watchdog.sh"; then
  echo "main bridge lifecycle must not reference the optional adapter" >&2
  exit 1
fi

adapter start >/dev/null
adapter status >/dev/null
adapter start >/dev/null

curl -fsS "$BASE/health/ready" | grep -Fq 'state: ready'

ABOUT_RESPONSE="$(curl -fsS "$BASE/v1/about")"
grep -Fq 'universal_profile: universal-get-v1' <<<"$ABOUT_RESPONSE"
grep -Fq 'enhanced_profile: json-post-v1' <<<"$ABOUT_RESPONSE"

GENERATED_MASTER_RECORD="$(adapter set-master-bearer)"
GENERATED_MASTER="$(sed -n 's/^master_bearer: //p' <<<"$GENERATED_MASTER_RECORD")"
test "${#GENERATED_MASTER}" = 43
grep -Fq 'access_ttl_seconds: 21600' <<<"$GENERATED_MASTER_RECORD"

CUSTOM_MASTER='custom-master-bearer-for-adapter-test-0001'
adapter set-master-bearer "$CUSTOM_MASTER" | grep -Fq 'master_bearer: set'
OLD_MASTER_HTTP="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $GENERATED_MASTER" "$BASE/v1/access")"
test "$OLD_MASTER_HTTP" = 401
BAD_MASTER_HTTP="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer wrong-master-bearer-for-adapter-test-0000' "$BASE/v1/access")"
test "$BAD_MASTER_HTTP" = 401
ACCESS_RESPONSE="$(curl -fsS -X POST -H "Authorization: Bearer $CUSTOM_MASTER" "$BASE/v1/access")"
node -e '
  const value = JSON.parse(process.argv[1]);
  if (value.protocol !== "WEBSESSION-MCP-BRIDGE/1" || value.state !== "ready" || value.scope !== "main") process.exit(1);
  if (value.ttl_seconds !== 21600 || !/^[A-Za-z0-9_-]{43}$/.test(value.capability)) process.exit(1);
  const delta = Date.parse(value.expires_at) - Date.now();
  if (delta < 21_590_000 || delta > 21_600_000) process.exit(1);
' "$ACCESS_RESPONSE"
if grep -R -Fq "$CUSTOM_MASTER" "$TMP/state/mcp-dev-bridge/websession-adapter"; then
  echo "adapter state leaked raw master bearer" >&2
  exit 1
fi

CAPABILITY_RECORD="$(adapter issue-cap 60)"
CAPABILITY_ID="$(sed -n 's/^capability_id: //p' <<<"$CAPABILITY_RECORD")"
CAPABILITY="$(sed -n 's/^capability: //p' <<<"$CAPABILITY_RECORD")"
grep -Fq 'scope: main' <<<"$CAPABILITY_RECORD"
adapter revoke-cap "$CAPABILITY_ID" >/dev/null
REVOKED_HTTP="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/v1/s/$CAPABILITY/tools")"
test "$REVOKED_HTTP" = 404

PAYLOAD="$(head -c 512 </dev/zero | tr '\0' A)"
EXPECTED_SHA="$(printf '%s' "$PAYLOAD" | sha256sum | cut -d' ' -f1)"
ECHO_RESPONSE="$(curl -fsS "$BASE/probe/echo-path/$PAYLOAD")"
grep -Fq 'payload_bytes: 512' <<<"$ECHO_RESPONSE"
grep -Fq "sha256: $EXPECTED_SHA" <<<"$ECHO_RESPONSE"

REQUEST_RESPONSE="$(curl -fsS -A 'websession-adapter-test/1.0' "$BASE/probe/request/test-nonce?alpha=one")"
grep -Fq 'nonce: test-nonce' <<<"$REQUEST_RESPONSE"
grep -Fq 'query: ?alpha=one' <<<"$REQUEST_RESPONSE"
grep -Fq 'user_agent: websession-adapter-test/1.0' <<<"$REQUEST_RESPONSE"

HTTP_BODY='{"probe_id":"post-test","message":"probe","number":12345,"unicode":"✓"}'
HTTP_RESPONSE="$(curl -fsS \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer test-secret-not-echoed' \
  -H 'Idempotency-Key: post-test' \
  -H 'X-WebSession-Probe: test' \
  --data "$HTTP_BODY" \
  "$BASE/probe/http/post-test")"
grep -Fq 'method: POST' <<<"$HTTP_RESPONSE"
grep -Fq 'content_type: application/json' <<<"$HTTP_RESPONSE"
grep -Fq 'authorization_present: yes' <<<"$HTTP_RESPONSE"
grep -Fq 'idempotency_key_present: yes' <<<"$HTTP_RESPONSE"
grep -Fq 'idempotency_key_matches_nonce: yes' <<<"$HTTP_RESPONSE"
grep -Fq 'x_websession_probe: test' <<<"$HTTP_RESPONSE"
grep -Fq 'json_valid: yes' <<<"$HTTP_RESPONSE"
grep -Fq 'probe_id_matches_nonce: yes' <<<"$HTTP_RESPONSE"
if grep -Fq 'test-secret-not-echoed' <<<"$HTTP_RESPONSE"; then
  echo "probe response leaked Authorization value" >&2
  exit 1
fi

DELAY_RESPONSE="$(curl -fsS "$BASE/probe/delay/0")"
grep -Fq 'requested_seconds: 0' <<<"$DELAY_RESPONSE"
grep -Fq 'server_elapsed_ms:' <<<"$DELAY_RESPONSE"

PAGE_RESPONSE="$(curl -fsS "$BASE/probe/page/prefetch-test")"
grep -Fq "$BASE/probe/hit/instructed/prefetch-test" <<<"$PAGE_RESPONSE"
grep -Fq "$BASE/probe/hit/canary-a/prefetch-test" <<<"$PAGE_RESPONSE"
curl -fsS "$BASE/probe/hit/instructed/prefetch-test" | grep -Fq 'kind: instructed'

EVIDENCE="$TMP/state/mcp-dev-bridge/websession-adapter/probe.jsonl"
test -s "$EVIDENCE"
grep -Fq '"route":"echo-path"' "$EVIDENCE"
grep -Fq '"route":"request"' "$EVIDENCE"
grep -Fq '"route":"http"' "$EVIDENCE"
grep -Fq '"authorization_present":true' "$EVIDENCE"
if grep -Fq 'test-secret-not-echoed' "$EVIDENCE"; then
  echo "probe evidence leaked Authorization value" >&2
  exit 1
fi
grep -Fq '"route":"delay"' "$EVIDENCE"
grep -Fq '"route":"hit"' "$EVIDENCE"

test ! -e "$TMP/run/mcp-dev-bridge/cloudflare-oauth.enabled"

adapter stop >/dev/null
if curl -fsS -m 1 "$BASE/health/ready" >/dev/null 2>&1; then
  echo "adapter health remained reachable after explicit stop" >&2
  exit 1
fi

echo "adapter probe isolation OK"
