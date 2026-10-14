#!/usr/bin/env bash
# Sourced by adapter-probe.sh after its existing isolation assertions.
# shellcheck disable=SC2154

CLIENT="$TMP/wh"
curl -fsS --max-time 10 -D "$TMP/client.headers" "$BASE/v1/client.sh" -o "$CLIENT"
grep -Fiq 'content-type: text/x-shellscript; charset=utf-8' "$TMP/client.headers"
chmod +x "$CLIENT"
export WH_HOME="$TMP/wh-home"

CLIENT_CAP_RECORD="$(adapter issue-cap 3600)"
CLIENT_CAP_ID="$(sed -n 's/^capability_id: //p' <<<"$CLIENT_CAP_RECORD")"
CLIENT_CAP="$(sed -n 's/^capability: //p' <<<"$CLIENT_CAP_RECORD")"
printf 'Authorization: Bearer %s\n' "$CLIENT_CAP" > "$TMP/client-auth"
chmod 600 "$TMP/client-auth"

assert_json() {
  node - "$@" <<'NODE'
import { readFileSync } from 'node:fs';
const [path, expression] = process.argv.slice(2);
const value = JSON.parse(readFileSync(path, 'utf8'));
if (!Function('value', `return (${expression})`)(value)) throw new Error(`JSON assertion failed: ${expression}`);
NODE
}

json_field() {
  node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]))' "$@"
}

printf '%s\n' "$CLIENT_CAP" | "$CLIENT" login "$BASE" > "$TMP/login"
printf 'ok: 4 tools\n' > "$TMP/login.expected"
cmp "$TMP/login.expected" "$TMP/login"
"$CLIENT" tools > "$TMP/tools"
printf 'echo\nsleep\nbig\nmixed\n' > "$TMP/tools.expected"
cmp "$TMP/tools.expected" "$TMP/tools"
"$CLIENT" schema echo > "$TMP/schema"
assert_json "$TMP/schema" 'value.name === "echo" && value.inputSchema.properties.text.type === "string"'
"$CLIENT" instructions > "$TMP/instructions"
printf 'Adapter integration test instructions.' > "$TMP/instructions.expected"
cmp "$TMP/instructions.expected" "$TMP/instructions"
grep -Fq 'long_poll_max_seconds: 90' <<<"$ABOUT_RESPONSE"
grep -Fq "client_url: $BASE/v1/client.sh" <<<"$ABOUT_RESPONSE"
grep -Fq 'tool_timeout_ms: 120000' <<<"$ABOUT_RESPONSE"

"$CLIENT" call echo '{"text":"héllo\nresult: fake"}' > "$TMP/echo"
printf 'héllo\nresult: fake' > "$TMP/echo.expected"
cmp "$TMP/echo.expected" "$TMP/echo"

POSTS_BEFORE=$(grep -c 'POST /v1/calls ' "$TMP/adapter.log" || true)
STATUS_BEFORE=$(grep -c 'GET /v1/operations/' "$TMP/adapter.log" || true)
"$CLIENT" call sleep '{"seconds":5}' > "$TMP/sleep"
printf 'slept' > "$TMP/sleep.expected"
cmp "$TMP/sleep.expected" "$TMP/sleep"
POSTS_AFTER=$(grep -c 'POST /v1/calls ' "$TMP/adapter.log" || true)
STATUS_AFTER=$(grep -c 'GET /v1/operations/' "$TMP/adapter.log" || true)
test "$((POSTS_AFTER - POSTS_BEFORE))" = 1
test "$STATUS_AFTER" = "$STATUS_BEFORE"

node --input-type=module - "$ROOT" "$TMP/big.expected" <<'NODE'
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [root, output] = process.argv.slice(2);
const { BIG_RESULT } = await import(pathToFileURL(`${root}/tests/fixtures/adapter-mcp-stub.mjs`));
if (Buffer.byteLength(BIG_RESULT) !== 102400 || !BIG_RESULT.includes('🌍')) throw new Error('bad big fixture');
writeFileSync(output, BIG_RESULT);
NODE
"$CLIENT" call big > "$TMP/big"
test "$(sha256sum "$TMP/big" | cut -d' ' -f1)" = "$(sha256sum "$TMP/big.expected" | cut -d' ' -f1)"
"$CLIENT" call mixed > "$TMP/mixed"
assert_json "$TMP/mixed" 'value.content.length === 2 && value.content[0].text === "mixed text" && value.content[1].type === "image" && value.content[1].data === "aGVsbG8="'

node - "$TMP" <<'NODE'
import { writeFileSync } from 'node:fs';
const directory = process.argv[2];
const text = 'A'.repeat(200 * 1024);
writeFileSync(`${directory}/large-arguments`, JSON.stringify({ text }));
writeFileSync(`${directory}/large.expected`, text);
writeFileSync(`${directory}/oversize`, JSON.stringify({ version: 1, tool: 'echo', arguments: { text: 'A'.repeat(2 * 1024 * 1024) } }));
NODE
"$CLIENT" call echo "@$TMP/large-arguments" > "$TMP/large"
cmp "$TMP/large.expected" "$TMP/large"
HTTP_CODE=$(curl -sS --max-time 10 -o "$TMP/oversize-response" -w '%{http_code}' \
  -H "@$TMP/client-auth" -H 'Content-Type: application/json' -H 'Idempotency-Key: oversize' \
  --data-binary "@$TMP/oversize" "$BASE/v1/calls?wait=90")
test "$HTTP_CODE" = 413
assert_json "$TMP/oversize-response" 'value.code === "body_too_large"'

START_MS=$(($(date +%s%N) / 1000000))
curl -fsS --max-time 10 -H "@$TMP/client-auth" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: compatibility-sleep' --data '{"version":1,"tool":"sleep","arguments":{"seconds":4}}' \
  "$BASE/v1/calls" > "$TMP/compatibility"
ELAPSED_MS=$(($(date +%s%N) / 1000000 - START_MS))
if (( ELAPSED_MS >= 3000 )); then
  echo "compatibility response took $ELAPSED_MS ms (expected under 3000)" >&2
  exit 1
fi
assert_json "$TMP/compatibility" 'value.state === "running" && value.status_url.includes("/v1/operations/")'
STATUS_URL=$(json_field "$TMP/compatibility" status_url)
for _ in {1..30}; do
  curl -fsS --max-time 10 "$STATUS_URL" > "$TMP/status"
  [[ $(json_field "$TMP/status" state) != completed ]] || break
  sleep 0.1
done
assert_json "$TMP/status" 'value.state === "completed" && value.result === "slept"'
curl -fsS --max-time 10 -H "@$TMP/client-auth" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: compatibility-big' --data '{"version":1,"tool":"big","arguments":{}}' \
  "$BASE/v1/calls" > "$TMP/chunked"
assert_json "$TMP/chunked" 'value.state === "completed" && value.chunk_count > 1 && value.chunk_base_url.endsWith("/chunk/") && !("result" in value)'

for INVALID_WAIT in abc 91; do
  HTTP_CODE=$(curl -sS --max-time 10 -o "$TMP/invalid-wait" -w '%{http_code}' \
    -H "@$TMP/client-auth" -H 'Content-Type: application/json' -H "Idempotency-Key: invalid-$INVALID_WAIT" \
    --data '{"version":1,"tool":"echo","arguments":{"text":"x"}}' "$BASE/v1/calls?wait=$INVALID_WAIT")
  test "$HTTP_CODE" = 400
  assert_json "$TMP/invalid-wait" 'value.protocol === "WEBSESSION-MCP-BRIDGE/1" && value.state === "rejected" && value.code === "invalid_wait"'
  HTTP_CODE=$(curl -sS --max-time 10 -o "$TMP/invalid-wait" -w '%{http_code}' "$STATUS_URL?wait=$INVALID_WAIT")
  test "$HTTP_CODE" = 400
  assert_json "$TMP/invalid-wait" 'value.code === "invalid_wait"'
done

adapter revoke-cap "$CLIENT_CAP_ID" >/dev/null
HTTP_CODE=$(curl -sS --max-time 10 -o "$TMP/revoked" -w '%{http_code}' -H "@$TMP/client-auth" "$BASE/v1/tools")
test "$HTTP_CODE" = 401
assert_json "$TMP/revoked" 'value.code === "authorization_required"'
if "$CLIENT" call echo '{"text":"revoked"}' > "$TMP/revoked-call" 2> "$TMP/revoked-error"; then
  echo 'revoked capability unexpectedly permitted a call' >&2
  exit 1
fi
if grep -Fq -e "$CLIENT_CAP" -e "$CAPABILITY" -e "$CUSTOM_MASTER" -e 'Authorization: Bearer' -e 'test-secret-not-echoed' "$TMP/adapter.log"; then
  echo 'adapter log leaked authorization material' >&2
  exit 1
fi

echo "adapter client integration OK (compatibility response ${ELAPSED_MS} ms)"
