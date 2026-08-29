# Python bridge prompt for AI environments without native MCP support

Use this when an AI environment can execute Python and make outbound HTTPS requests but does not provide a native MCP client/integration. Prefer the official MCP Python SDK when it is available. If package installation is blocked, use the package-free standard-library fallback in this document instead of giving up or reverting to an ad-hoc one-shot HTTP call.

## Copy/paste prompt

```text
Act as an advanced Python agent. I need you to connect to a remote, OAuth-protected MCP server from your Python/code-execution environment.

Target MCP URL:
https://mcp.example.com/mcp

STRICT REQUIREMENTS

1. Do NOT use raw `requests`, `urllib`, `curl`, or hand-written JSON-RPC as the MCP client implementation. Use the official MCP Python SDK v2 (`mcp` package), `httpx2`, and `streamable_http_client`.

2. Use the SDK's `OAuthClientProvider` for OAuth discovery, PKCE, authorization, token exchange, and authenticated HTTP requests. Do not ask me to paste an access token, refresh token, client secret, or bearer token into the conversation.

3. Implement a headless authorization flow suitable for a sandbox:
   - generate the authorization URL;
   - print only the authorization URL and any non-secret instructions required for me to complete authorization;
   - PAUSE before attempting authenticated MCP calls;
   - ask me to open the URL, authorize the client, and paste back either the resulting callback URL or the `code=` value (and `state` if the SDK requires it);
   - validate the returned OAuth state before exchanging the code.

4. Once authentication succeeds, build a small reusable `portable_mcp` CLI shim inside the sandbox. Keep it minimal and machine-oriented. It must support at least:
   - `connect` / authentication setup;
   - `tools` or `tools-list`;
   - `schema <tool-name>`;
   - `call <tool-name> <json-arguments>`.

5. Cache OAuth state/tokens only inside the current sandbox/session unless durable local storage is clearly available and appropriate. If writing token material to disk:
   - use a private file location;
   - restrict permissions to the current user where the platform permits it;
   - never print token contents to stdout/stderr or echo them back to me;
   - never commit token/cache files to a repository.

6. Use the official SDK's client/transport behavior for MCP protocol negotiation, initialization/session compatibility, Streamable HTTP, SSE handling where applicable, tool discovery, and tool calls. Do not manually recreate protocol-version headers, session IDs, initialization handshakes, or SSE framing unless the official SDK itself requires an explicit compatibility step.

7. After authentication, call `tools/list` through the SDK and return a machine-readable JSON document containing the available tool definitions. Preserve, where present:
   - tool name;
   - description;
   - input JSON schema;
   - output/result schema or structured-content metadata;
   - annotations/capability metadata exposed by the SDK.

8. Do not invoke any discovered write/destructive tool merely to test connectivity. Tool discovery is read-only. Wait for an explicit instruction before executing a tool that can modify files, processes, repositories, terminals, external services, or other state.

9. Keep stdout machine-readable after the interactive OAuth step. Send diagnostics to stderr where practical. For CLI commands, prefer JSON output with explicit success/error fields instead of prose mixed into payloads.

10. Fail clearly instead of silently falling back to an unsafe implementation. If the official SDK cannot be installed because package installation is blocked, but Python's standard library and outbound HTTPS still work, switch to the package-free fallback prompt below. If outbound HTTPS or interactive OAuth completion itself is blocked, stop and explain the exact blocker. If SDK APIs have changed, consult the current official MCP Python SDK documentation and adapt to the supported v2 API before choosing the package-free fallback.

IMPLEMENTATION ORDER

A. Inspect the Python environment and install/import the current official MCP Python SDK v2 and `httpx2` if needed.
B. Create the OAuth client provider and session-local token storage.
C. Generate the authorization URL, print it, and stop for my callback/code.
D. Resume only after I supply the callback/code; complete OAuth and verify an authenticated MCP connection.
E. Build the `portable_mcp` shim around the working SDK client.
F. Run the shim's tool-list command.
G. Return the complete available tool catalog as machine-readable JSON.

Security rule: OAuth authorization codes and tokens are credentials. Minimize their exposure, do not log them, and do not ask me to send long-lived bearer credentials through chat.
```

## Package-free fallback prompt

Use this version when `pip`, PyPI, wheel installation, or third-party imports are unavailable but normal Python standard-library networking is allowed.

```text
Act as an advanced Python agent. I need you to connect to a remote, OAuth-protected MCP server from a constrained Python sandbox with NO third-party package installation.

Target MCP URL:
https://mcp.example.com/mcp

STRICT REQUIREMENTS

1. Use Python standard-library modules only. Do not install or import `mcp`, `requests`, `httpx`, `httpx2`, `aiohttp`, or any other third-party dependency. Appropriate stdlib modules include `urllib.request`, `urllib.parse`, `urllib.error`, `json`, `ssl`, `secrets`, `hashlib`, `base64`, `http.server`, `threading`, `time`, `pathlib`, and `os`.

2. This is a standards-driven MCP client fallback, not a toy one-shot POST. Implement the protocol deliberately and keep the transport/OAuth code isolated in a small reusable `portable_mcp_stdlib.py` shim. Every outbound HTTP request must send an explicit, honest, non-empty client `User-Agent`, for example `portable-mcp-stdlib/1.0`; do not rely on Python `urllib`'s default `Python-urllib/...` fingerprint. Keep this header stable across OAuth discovery, dynamic registration, token exchange, and MCP requests. Do not spoof a browser User-Agent unless the user explicitly asks for that diagnostic.

3. Discover OAuth instead of hard-coding credentials:
   - first inspect the MCP endpoint's `401 WWW-Authenticate` challenge when useful;
   - fetch RFC 9728 protected-resource metadata from the advertised `resource_metadata` URL or the standard well-known location;
   - obtain the canonical `resource`, authorization-server issuer, and requested/supported scopes from discovery;
   - fetch OAuth Authorization Server Metadata from the discovered issuer;
   - require an authorization endpoint, token endpoint, and PKCE `S256` support;
   - use a discovered dynamic registration endpoint when available. Do not invent a client ID;
   - for metadata GETs send at least `User-Agent: portable-mcp-stdlib/1.0` and `Accept: application/json`;
   - if discovery returns an HTTP error, report the HTTP status plus a bounded, non-secret response body/headers to stderr instead of collapsing it into a generic `Failed to discover ...` exception. In particular, Cloudflare error 1010 means the client fingerprint was blocked; retry once with the explicit honest User-Agent above, not a rotating/spoofed browser fingerprint.

4. Register a public/native OAuth client when registration is required. Prefer:
   - `token_endpoint_auth_method: none`;
   - `grant_types: ["authorization_code"]`;
   - `response_types: ["code"]`;
   - a loopback redirect URI such as `http://127.0.0.1:<port>/callback`;
   - `application_type: native` when accepted by the registration endpoint.
   Keep any returned client secret private if the server unexpectedly issues one, and follow the server's advertised token-auth method rather than printing credentials.

5. Implement OAuth Authorization Code + PKCE with the standard library:
   - BEFORE generating an authorization URL, establish how the OAuth transaction state will survive the human authorization round-trip. The exact PKCE verifier, OAuth `state`, registered `client_id`, redirect URI, resource value, issuer, and relevant authorization metadata must still be available when the callback/code is redeemed;
   - prefer one long-lived Python process when the environment can keep it alive across the human wait. Keep the verifier/state in that process and do not terminate it before token exchange;
   - otherwise choose a private session-persistent storage location outside a repository where possible. Do NOT assume `/tmp` survives merely because it is writable;
   - prove persistence BEFORE authorization with a harmless two-execution probe: execution 1 writes a random non-secret probe ID to the intended state location and prints only that probe ID; execution 2 verifies the same probe ID is still present. Only after that succeeds may the verifier/state be stored there and an authorization URL be shown;
   - if neither a long-lived process nor verified session-persistent private storage survives across executions, STOP before opening the authorization flow. Explain that this runtime cannot safely resume a PKCE transaction. Do not generate repeated "final" authorization URLs and do not put the PKCE verifier into chat, the OAuth `state` parameter, the callback URL, or another user-visible transport as a workaround;
   - generate `state` with `secrets`;
   - generate a high-entropy PKCE verifier;
   - compute the S256 challenge with SHA-256 plus URL-safe base64 without padding;
   - include `resource` in BOTH authorization and token requests;
   - request only the discovered/required MCP scopes;
   - print the authorization URL, then PAUSE and ask me to authorize it;
   - if the sandbox and my browser do not share localhost, do not wait forever for a loopback listener: tell me the browser redirect may fail locally and ask me to paste the final callback URL from the address bar;
   - accept either the full callback URL or the returned `code` plus `state`;
   - verify `state` before token exchange;
   - if an `iss` parameter is returned, verify it matches the discovered authorization-server issuer before redeeming the code.

6. Persist/resume the OAuth transaction safely, then exchange the code at the discovered token endpoint using `application/x-www-form-urlencoded`:
   - save the transaction state atomically before printing the authorization URL when a persistent file is required;
   - restrict the file to the current user (`0600`) where the platform permits it;
   - on the callback execution, load the SAME saved transaction and reject the callback if the expected state/client/redirect/resource context is missing or inconsistent;
   - delete the one-time verifier/state transaction file after successful token exchange, and discard it after a failed/expired authorization attempt before starting a fresh one;
   - never print the access token, authorization code, PKCE verifier, client secret, or token response. Keep credentials in memory when possible. If a session-local token cache is needed across CLI invocations, use a separate private file. Never commit credential state.

7. After authentication, implement MCP Streamable HTTP with bounded timeouts and these baseline headers:
   - `User-Agent: portable-mcp-stdlib/1.0`;
   - `Authorization: Bearer <access-token>`;
   - `Content-Type: application/json` for POSTs;
   - `Accept: application/json, text/event-stream`.
   Parse both ordinary JSON responses and SSE responses. For SSE, read event lines incrementally until the JSON-RPC response matching the request ID is received; do not block waiting for the entire stream to close.

8. Support MCP protocol negotiation without assuming one era:

   MODERN FIRST:
   - probe `2026-07-28` with `server/discover`;
   - send `MCP-Protocol-Version: 2026-07-28` and `Mcp-Method: server/discover`;
   - include per-request `_meta` containing protocol version, client identity, and client capabilities;
   - if accepted, use the modern stateless request model for `tools/list` and later calls, including `Mcp-Method` and `Mcp-Name` where the method has a named target such as `tools/call`.

   LEGACY FALLBACK:
   - if the modern probe returns method-not-found, unsupported-protocol, or a transport response indicating that the 2026 revision is unsupported, fall back to the latest initialize-capable version the server accepts, starting with `2025-11-25`;
   - POST `initialize` with client info and capabilities;
   - use the `protocolVersion` returned by the server;
   - capture `Mcp-Session-Id`/`MCP-Session-Id` case-insensitively if returned;
   - POST `notifications/initialized`;
   - include the negotiated `MCP-Protocol-Version` and session ID on later requests when required;
   - if a request with a session ID receives HTTP 404, create a fresh legacy session rather than reusing stale state.

9. Build a session-local CLI around the working client with at least:
   - `auth` or `connect`;
   - `tools` / `tools-list`;
   - `schema <tool-name>`;
   - `call <tool-name> <json-arguments>`.
   Keep successful CLI stdout machine-readable JSON. Send diagnostics to stderr.

10. First authenticated MCP action: call `tools/list` only. Return the complete available tool definitions as machine-readable JSON, preserving tool name, description, input schema, output/result schema when present, and annotations/metadata.

11. Do not call a write/destructive tool merely to prove the connection works. Wait for explicit authorization before invoking tools that can mutate files, repositories, processes, terminals, services, or external state.

12. Do not depend on refresh-token support. Cache the access token only for the current sandbox/session. If it expires or the server returns an authentication failure that cannot be resolved without reauthorization, repeat the authorization-code flow.

13. Fail closed on security or protocol ambiguity. In particular, stop if:
   - PKCE S256 is not advertised;
   - OAuth state validation fails;
   - the callback issuer conflicts with the discovered issuer;
   - TLS certificate verification fails;
   - the server negotiates an MCP protocol version you did not implement;
   - OAuth discovery/registration cannot establish a valid client.

IMPLEMENTATION ORDER

A. Confirm Python stdlib HTTPS works using an explicit `User-Agent: portable-mcp-stdlib/1.0`; do not attempt package installation. If the default `urllib` fingerprint fails but this explicit User-Agent succeeds, treat that as an HTTP-edge/client-fingerprint issue, not an OAuth discovery failure.
B. Discover protected-resource and authorization-server metadata.
C. Dynamically register a public/native client if needed.
D. Determine whether one long-lived process or a private state location survives the human round-trip. If using storage, prove it with a harmless two-execution persistence probe before generating any authorization URL.
E. Generate PKCE + state, save the complete OAuth transaction securely if needed, print the authorization URL, and pause for my callback.
F. Resume from the SAME transaction, validate callback state/issuer, and exchange the code without exposing credentials. Delete the one-time verifier/state after successful exchange.
G. Probe MCP 2026-07-28; fall back to the legacy initialize/session flow if required.
H. Build `portable_mcp_stdlib.py` around the verified transport.
I. Run `tools/list` and return the tool catalog as JSON.

For this target, do not hard-code discovery results even if you have seen them before. Rediscover them on each fresh sandbox. Current deployments may expose protected-resource metadata, PKCE S256, and dynamic client registration, but live discovery is authoritative.

Adapt the implementation to the execution environment instead of assuming one sandbox shape. Preserve the protocol/security invariants above, but adjust operational details such as:

- callback strategy: local loopback listener when the browser can reach the sandbox, otherwise manual callback-URL/code paste;
- loopback host/port: choose an available port rather than assuming `8080` is free;
- credential/state storage: memory-only for one process, a private temporary/session file for multi-command shims, or another sandbox-local secret mechanism if provided;
- filesystem paths: do not assume `/tmp` exists or persists; derive a writable private location appropriate to the runtime;
- command invocation: adapt to notebook cells, a shell-capable sandbox, an ephemeral function runner, or a long-lived Python process;
- HTTP timeouts/proxies: use bounded timeouts and honor the environment's normal proxy/network configuration without disabling TLS verification;
- OAuth registration details: use what the discovered server accepts rather than assuming every provider accepts the same optional registration fields;
- MCP protocol version: negotiate from live server behavior and implement only versions whose wire contract the shim actually understands;
- SSE handling: use incremental line/event parsing when the response is `text/event-stream`; do not assume every MCP response is one JSON body;
- persistence: distinguish "temporary files are cleared" from "the whole execution environment is reset." Probe the intended state location across two separate executions before OAuth. If a home/workspace/session volume persists, use a private non-repository directory there; if only one long-running process persists, keep the verifier/state in that process; if nothing survives, stop before authorization rather than forcing the user through repeated unusable codes.

Do not weaken state validation, PKCE, TLS verification, OAuth discovery, resource binding, or credential secrecy merely to accommodate an awkward environment. If adaptation cannot preserve those properties, report the environment limitation as the blocker.
```

### Package-free reference scaffold

The following is a **starting scaffold**, not a fixed drop-in program. A future AI should adapt paths, callback handling, port selection, storage lifetime, and transport behavior to its actual runtime while preserving the requirements above.

```python
#!/usr/bin/env python3
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

MCP_URL = "https://mcp.example.com/mcp"
USER_AGENT = "portable-mcp-stdlib/1.0"
HTTP_TIMEOUT_SECONDS = 15

# Adapt this location to the sandbox. It MUST be proven to survive between the
# execution that prints the authorization URL and the execution that redeems
# the callback. Prefer a private session/home location outside repositories.
# Never assume /tmp persists. An environment variable lets a host provide a
# better session-specific location without editing this scaffold.
STATE_DIR = Path(
    os.environ.get(
        "PORTABLE_MCP_STATE_DIR",
        str(Path.home() / ".portable_mcp"),
    )
)
PROBE_FILE = STATE_DIR / "persistence-probe.json"
AUTH_TXN_FILE = STATE_DIR / "oauth-transaction.json"


def json_stderr(label, **fields):
    print(json.dumps({"event": label, **fields}, separators=(",", ":")), file=sys.stderr)


def bounded_body(text, limit=1000):
    return text[:limit]


def write_private_json(path, payload):
    """Write sensitive/session state atomically with private permissions."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    data = json.dumps(payload, separators=(",", ":"))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


def read_private_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def begin_persistence_probe():
    """Run in execution 1, then verify in a separate execution before OAuth."""
    probe_id = secrets.token_urlsafe(24)
    write_private_json(
        PROBE_FILE,
        {"probe_id": probe_id, "created_at": int(__import__("time").time())},
    )
    # The probe ID is deliberately non-secret and may be carried across turns.
    return probe_id


def verify_persistence_probe(expected_probe_id):
    """Run in execution 2. Failure means this location cannot hold PKCE state."""
    if not PROBE_FILE.exists():
        raise RuntimeError(
            "state location did not survive across executions; choose another "
            "persistent location or keep one process alive before starting OAuth"
        )
    probe = read_private_json(PROBE_FILE)
    if not secrets.compare_digest(probe.get("probe_id", ""), expected_probe_id):
        raise RuntimeError("persistence probe identity mismatch")
    PROBE_FILE.unlink(missing_ok=True)
    return True


def request(url, *, data=None, headers=None, method=None, json_body=None):
    """Small HTTPS helper with stable identification and useful diagnostics."""
    merged = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    }
    if headers:
        merged.update(headers)

    if json_body is not None:
        data = json.dumps(json_body, separators=(",", ":")).encode("utf-8")
        merged["Content-Type"] = "application/json"
    elif isinstance(data, dict):
        data = urllib.parse.urlencode(data).encode("utf-8")
        merged.setdefault("Content-Type", "application/x-www-form-urlencoded")
    elif isinstance(data, str):
        data = data.encode("utf-8")

    req = urllib.request.Request(url, data=data, headers=merged, method=method)
    ctx = ssl.create_default_context()  # Never disable certificate verification.

    try:
        with urllib.request.urlopen(req, context=ctx, timeout=HTTP_TIMEOUT_SECONDS) as resp:
            return resp.status, resp.read().decode("utf-8"), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return exc.code, body, dict(exc.headers)


def require_json_200(url, *, label, **kwargs):
    status, body, headers = request(url, **kwargs)
    if status != 200:
        json_stderr(
            "http_error",
            step=label,
            status=status,
            server=headers.get("Server") or headers.get("server"),
            body=bounded_body(body),
        )
        raise RuntimeError(f"{label} failed with HTTP {status}")
    try:
        return json.loads(body), headers
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{label} returned invalid JSON") from exc


def protected_resource_metadata_url(mcp_url):
    parsed = urllib.parse.urlsplit(mcp_url)
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, "/.well-known/oauth-protected-resource", "", "")
    )


def authorization_metadata_url(issuer):
    # This layout is correct for the current target. If live discovery or a
    # different provider advertises another standards-compliant metadata URL,
    # adapt rather than hard-coding assumptions from this example.
    return issuer.rstrip("/") + "/.well-known/oauth-authorization-server"


def discover_oauth():
    resource_meta, _ = require_json_200(
        protected_resource_metadata_url(MCP_URL),
        label="protected-resource discovery",
    )

    issuers = resource_meta.get("authorization_servers") or []
    if not issuers:
        raise RuntimeError("protected-resource metadata has no authorization_servers")

    issuer = issuers[0]
    auth_meta, _ = require_json_200(
        authorization_metadata_url(issuer),
        label="authorization-server discovery",
    )

    required = ("authorization_endpoint", "token_endpoint")
    missing = [key for key in required if not auth_meta.get(key)]
    if missing:
        raise RuntimeError(f"authorization metadata missing: {missing}")
    if "S256" not in (auth_meta.get("code_challenge_methods_supported") or []):
        raise RuntimeError("authorization server does not advertise PKCE S256")

    return resource_meta, auth_meta


def register_public_client(auth_meta, redirect_uri, scopes):
    registration_endpoint = auth_meta.get("registration_endpoint")
    if not registration_endpoint:
        raise RuntimeError("no registration_endpoint; obtain a valid client_id another supported way")

    payload = {
        "client_name": "Portable MCP stdlib client",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "application_type": "native",
        "scope": " ".join(scopes),
    }
    status, body, _ = request(registration_endpoint, json_body=payload, method="POST")
    if status not in (200, 201):
        json_stderr("registration_error", status=status, body=bounded_body(body))
        raise RuntimeError(f"dynamic client registration failed with HTTP {status}")

    info = json.loads(body)
    if not info.get("client_id"):
        raise RuntimeError("registration response did not contain client_id")
    return info


def pkce_pair():
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def build_authorization(resource_meta, auth_meta, client_id, redirect_uri):
    supported = resource_meta.get("scopes_supported") or auth_meta.get("scopes_supported") or []
    # Adapt requested scopes to the actual task. Do not request more than needed.
    requested_scopes = [s for s in ("tag:code", "tag:dev", "tag:terminal") if s in supported]
    verifier, challenge = pkce_pair()
    state = secrets.token_urlsafe(32)
    resource = resource_meta.get("resource") or MCP_URL

    query = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(requested_scopes),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "resource": resource,
    }
    url = auth_meta["authorization_endpoint"] + "?" + urllib.parse.urlencode(query)
    return {
        "authorization_url": url,
        "state": state,
        "verifier": verifier,
        "redirect_uri": redirect_uri,
        "resource": resource,
        "scopes": requested_scopes,
    }


def save_oauth_transaction(auth_state, client_info, auth_meta):
    """Persist only after the storage location passed the two-execution probe."""
    write_private_json(
        AUTH_TXN_FILE,
        {
            "client_info": client_info,
            "auth_state": auth_state,
            "issuer": auth_meta.get("issuer"),
            "token_endpoint": auth_meta.get("token_endpoint"),
        },
    )


def load_oauth_transaction():
    if not AUTH_TXN_FILE.exists():
        raise RuntimeError(
            "OAuth transaction state is missing; do not redeem a callback against "
            "a newly generated verifier. Start a fresh authorization only after "
            "fixing persistence."
        )
    return read_private_json(AUTH_TXN_FILE)


def clear_oauth_transaction():
    AUTH_TXN_FILE.unlink(missing_ok=True)


def parse_callback(value, expected_state, expected_issuer=None):
    """Accept a full callback URL; adapt if the environment returns fields separately."""
    parsed = urllib.parse.urlsplit(value.strip())
    params = urllib.parse.parse_qs(parsed.query)
    error = (params.get("error") or [None])[0]
    if error:
        raise RuntimeError(f"authorization failed: {error}")

    code = (params.get("code") or [None])[0]
    state = (params.get("state") or [None])[0]
    issuer = (params.get("iss") or [None])[0]
    if not code:
        raise RuntimeError("callback did not contain code")
    if state != expected_state:
        raise RuntimeError("OAuth state mismatch")
    if issuer and expected_issuer and issuer.rstrip("/") != expected_issuer.rstrip("/"):
        raise RuntimeError("OAuth issuer mismatch")
    return code


def exchange_code(auth_meta, client_info, auth_state, code):
    form = {
        "grant_type": "authorization_code",
        "client_id": client_info["client_id"],
        "redirect_uri": auth_state["redirect_uri"],
        "code": code,
        "code_verifier": auth_state["verifier"],
        "resource": auth_state["resource"],
    }
    # If live registration metadata requires client authentication, adapt the
    # token request to that advertised method without logging the credential.
    status, body, _ = request(auth_meta["token_endpoint"], data=form, method="POST")
    if status != 200:
        json_stderr("token_error", status=status, body=bounded_body(body))
        raise RuntimeError(f"token exchange failed with HTTP {status}")
    token = json.loads(body)
    if not token.get("access_token"):
        raise RuntimeError("token response contained no access_token")
    return token
```

Before using `build_authorization()`, first decide whether the environment can keep one process alive. If not, run `begin_persistence_probe()` in one execution and `verify_persistence_probe(<printed probe id>)` in a genuinely separate execution. Only after that succeeds should the code create/save an OAuth transaction and print the authorization URL. On callback, call `load_oauth_transaction()` and redeem the code with that exact saved verifier/state; never regenerate them. Call `clear_oauth_transaction()` after a successful exchange or before intentionally abandoning an expired/failed transaction.

Continue from this scaffold by implementing the negotiated MCP transport (`2026-07-28` when supported, otherwise the initialize/session flow), SSE-aware response parsing, `tools/list`, schema lookup, and explicit tool calls. Do not blindly paste a large fixed implementation if the sandbox exposes different callback, filesystem, process, or networking constraints; inspect the runtime first and adapt the scaffold while preserving the security and protocol contracts.

### Why the package-free path is acceptable

The standard library has the primitives needed for this constrained fallback: HTTPS requests and headers/form POSTs (`urllib.request`/`urllib.parse`), secure random PKCE/state generation (`secrets`), SHA-256 and base64url encoding (`hashlib`/`base64`), and an optional loopback callback listener (`http.server`). The HTTP helper should merge a stable explicit `User-Agent` into every request and preserve HTTP status/body/header diagnostics on failures; some edge-security configurations reject Python `urllib`'s default fingerprint even though the same endpoint accepts an explicit application User-Agent. The important distinction is that this fallback implements the documented OAuth/MCP wire contracts as a reusable client rather than sending an isolated hard-coded `tools/call` request.

## Expected interaction

The first run should stop at the human authorization boundary rather than pretending the OAuth flow completed automatically:

```text
AI Python runtime
  -> official MCP Python SDK
  -> OAuth discovery + PKCE
  -> print authorization URL
  -> human authorizes in browser
  -> callback URL/code returned to runtime
  -> SDK exchanges code and caches session credential
  -> portable_mcp tools
  -> tools/list JSON
```

The resulting shim is intentionally a client adapter, not a replacement MCP implementation. Protocol negotiation, Streamable HTTP behavior, OAuth mechanics, and compatibility handling belong to the official SDK. If a future SDK revision changes import paths or APIs, update the adapter to the current official SDK rather than replacing the SDK with hand-written HTTP calls.
