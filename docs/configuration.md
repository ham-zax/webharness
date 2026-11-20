# Configuration

Configuration renders from three inputs into external runtime state:

```text
tracked template + explicit trust profile + local .env -> generated state outside Git
```

## Deployment identity (`.env`)

Copy `.env.example` to `.env` (Git-ignored) or pass `--env-file PATH`.

| Variable | Default | Purpose |
|---|---|---|
| `MCP_PUBLIC_URL` | *(required)* | Public HTTPS MCP origin (e.g. `https://mcp.example.com`). |
| `MCP_WORKSPACE_ROOT` | *(required for `restricted`/`trusted-dev`)* | Workspace root boundary for narrower profiles. |
| `MCP_PERSONAL_DEFAULT_CWD` | `$HOME` | Default cwd for `personal` and `server` profiles. |
| `MCP_ONE_MCP_PORT` | `3050` | Loopback listener port (match Cloudflare Tunnel ingress). |
| `MCP_TUNNEL_NAME` | `""` | Empty runs `cloudflared tunnel run` using default `~/.cloudflared/config.yml`; non-empty targets a named tunnel. |
| `MCP_TERMINAL_FRONTEND` | `kitty` | Personal-only collaborative launcher: `kitty` or `windows-terminal`. |
| `MCP_OWNER_CONTEXT_FILE` | `""` | Absolute path to private file (<=32 KiB) appended to `pi-dev` MCP initialization instructions. |
| `MCP_OWNER_ENV_FILE` | `""` | Absolute path to private file (<=64 KiB) with whitelisted GUI/browser overrides (`GALLIUM_DRIVER`, `MOZ_ENABLE_WAYLAND`, `AGENT_BROWSER_PROFILE`, `AGENT_BROWSER_EXECUTABLE_PATH`, `MCP_BROWSER_DEFAULT_TARGET`). |
| `MCP_LOCAL_SERVERS_FILE` | `""` | Absolute path to private JSON (<=128 KiB, `{"version":"1.0.0","mcpServers":{...}}`) adding owner stdio MCPs to `DirectLocalServerPool` (`restartOnExit: true` by default; optional `protocolVersion`: `"auto"`, `"legacy"`, or `"2026-07-28"`). |
| `MCP_SKILL_POLICY_FILE` | `skill-library/policy.json` | Optional alternate skill-library policy file. Set `MCP_SKILL_JEV_ENABLED=1` + `MCP_SKILL_JEV_ENV_FILE` (mode `0600`) only if opting into Jev selection. |

See [OAuth clients](oauth-clients.md) for client registration and [Getting Started](getting-started.md#provision-the-cloudflare-transport-used-by-the-reference-deployment) for Cloudflare Tunnel and OpenAI Secure MCP Tunnel boundaries.

## Profiles

| Profile | Outer servers | Authority |
|---|---|---|
| `restricted` | `dev` | Workspace-bounded `read`, `edit`, `write` only (no shell, no Local). |
| `trusted-dev` | `dev` | Workspace-bounded files + unrestricted `exec`/`bash` as the Linux user (no Local). |
| `personal` | `dev`, `local` | Full WSL workstation: all 12 Dev tools + Local (`terminal`, `host`, `skill-library`, `browser-fast`, `browser-daily`, `browser-devtools`, owner MCPs, hidden fallback-only `dev` mirror). |
| `server` | `dev`, `local` | Headless Linux/ARM server: Dev + Local (`terminal`, `skill-library`, owner MCPs, hidden `dev` mirror; no desktop/browser/host). Sets 365-day single-owner OAuth policy. |

## Browser policy (`browser-fast.json`)

Linux `browser-fast` and `browser-devtools` read `~/.config/mcp-dev-bridge/browser-fast.json` (starter template in `config/browser-fast.example.json`). Personal bootstrap installs V2 `cloakbrowser` / `x-main` only if the file is missing and never overwrites existing files. V2 supports named managed CloakBrowser profiles (`headless`, `humanize`, `humanPreset`, `platform`, `fingerprint`, `timezone`, `locale`, `extensions`, `proxy`, `geoip`). Override per call via `browser_backend="cloakbrowser"|"chrome"` without editing the file; supplying `browser_profile` on Linux requires explicit `browser_backend`. Firefox is unsupported (Chromium-CDP only).

## Rendering & generated state

`webharness setup` renders automatically. Direct rendering (also `just render personal|server`):

```bash
node scripts/render-config.mjs --profile personal --env-file .env [--check] [--state-dir PATH] [--repo-root PATH]
```

Persistent state defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge` (transient runtime under `${XDG_RUNTIME_DIR:-/run/user/$UID}/mcp-dev-bridge`):

- `bridge.env`, `owner.env` — rendered profile, URL, source root, and sanitized GUI vars.
- `1mcp/{mcp.json,config.toml,instructions-template.md}` — outer 1MCP config, log policy, and OAuth/session home.
- `local-1mcp/{mcp.json,config.toml}` — Local broker downstream pool config (written atomically before outer config, mode `0600`) and log policy.
- `logs/{one-mcp.log,local-inner.log}` — native rotated logs (dir mode `0700`, `umask 077`).
- `dev/` — durable wait state and retained command spools.

**Source root matters:** Rendered commands embed the checkout path. Before moving or deleting a checkout, follow [Safe source cutover](operations.md#safe-source-cutover).

## Output, log, and timeout policy

| Variable | Default | Bounds & behavior |
|---|---|---|
| `MCP_DEV_READ_DEFAULT_LINES` | `160` | `0..100000` (`0` disables line default; 16 KiB/file and 2000-line cap still apply; `targets` allows up to 20 files / 32 KiB combined). |
| `MCP_DEV_MAX_OUTPUT_BYTES` | `16384` | Inline cap for `exec`/`bash`/`run_script` (keeps head + tail, appends `[exit N · Ts]`, writes complete output to `full_output_path`). Lower caps save context tokens. |
| `MCP_DEV_IMPORT_MAX_BYTES` | `104857600` (100 MiB) | Cap up to 1 GiB for Personal `import_file`. |
| `MCP_DEV_MAX_SPOOL_BYTES` | `67108864` (64 MiB) | Per-command retained spool cap (max 256 MiB). |
| `MCP_DEV_SPOOL_TTL_SECONDS` | `604800` (7 days) | Finalized spool retention; GC runs on startup and after Bash calls. |
| `MCP_DEV_SPOOL_MAX_TOTAL_BYTES` | `536870912` (512 MiB) | Aggregate finalized spool cap across retained logs. |
| `MCP_ONE_MCP_LOG_MAX_SIZE_BYTES` | `10485760` (10 MiB) | `1..64` MiB per rotated file for both `one-mcp.log` and `local-inner.log`. |
| `MCP_ONE_MCP_LOG_MAX_FILES` | `5` | `1..10` rotated files retained via tailable Winston rotation. |

**Request timeouts:** Outer `dev` and `local` carry `requestTimeout: 240000` ms in `personal`/`server` (`60000` ms in `restricted`/`trusted-dev`); browser servers carry `180000` ms; owner MCPs default to `60000` ms. Connectors still enforce shorter HTTP windows (~45s routing target), so use `detach: true`, `pueued`, or Local Terminal + `wait` for long work.

## On-demand runtimes

| Variable | Default | Behavior |
|---|---|---|
| `BRIDGE_COLD_START` | `1` | Runs `wake-proxy` on `MCP_ONE_MCP_PORT` and starts 1MCP on `BRIDGE_BACKEND_PORT` (default port + 10) on demand. Set `0` to keep 1MCP running directly on the public port. |
| `BRIDGE_WAKE_IDLE_MS` | `1800000` (30m) | Evicts idle 1MCP after inactivity; `/health/ready` and `/health/live` do not wake it. Active streams and leases prevent eviction. |
| `MCP_DEV_WORKER_IDLE_MS` | `1800000` (30m) | Evicts the expendable Pi execution worker when idle (`0` disables). Durable `wait` stays in the lightweight facade. |
| `MCP_DEV_PREWARM_WORKER` | `1` (`personal`/`server`), `0` (`restricted`/`trusted-dev`) | Pre-forks the outer Dev execution worker at startup (still evicts after `MCP_DEV_WORKER_IDLE_MS`; set `0` to keep cold; omitted on the fallback-only inner mirror). |
| `MCP_LOCAL_INNER_IDLE_MS` | `1800000` (30m) | Evicts each idle `DirectLocalServerPool` stdio server independently (`0` disables). Unscoped `tool_list` wakes nothing. |
| `BRIDGE_CONNECTOR_POLICY_FILE` | `~/.config/mcp-dev-bridge/connector-policy.yaml` | Hot-reloading per-client connector policy (`default`, `clients`, `connector_write_tools`, `compat_annotations`, `banner`, `rpc_budget_seconds` (`10..300`), `log_client_identifiers`). See [Operations](operations.md#per-client-connector-policy-connector-policyyaml). |

## WebSession adapter (optional)

Operated separately via `bin/adapter`. Key knobs: pair-code TTL `3600s` (`30..3600`), session TTL `86400s` (`60..86400`), `WEBSESSION_ADAPTER_PUBLIC_URL`, `WEBSESSION_ADAPTER_STATE_DIR`, `WEBSESSION_ADAPTER_TOOL_TIMEOUT_MS` (default `120000`), and `WEBSESSION_ADAPTER_MAX_JSON_BODY_BYTES` (default `1048576`). See [WebSession clients](websession-clients.md) and [Headless Server](headless-server.md).
