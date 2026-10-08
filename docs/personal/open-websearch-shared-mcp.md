# Shared Open Web Search MCP

Claude, codex, and pi each used to spawn their own stdio `open-websearch` (about 110 MB resident each, five copies in practice). The personal workstation now runs one shared copy over loopback HTTP and each client points at it. Tool names stay native (`search`, `fetchWebContent`, `fetchGithubReadme`, `fetchCsdnArticle`, `fetchJuejinArticle`, `fetchLinuxDoArticle`), so existing `mcp__open-websearch__*` references keep working.

## Layout

| Piece | Location |
| --- | --- |
| Shared MCP service | `~/.config/systemd/user/open-websearch-mcp.service` (`MODE=http`, `PORT=3211`, endpoint `http://127.0.0.1:3211/mcp`) |
| Loopback shim | `~/.local/share/open-websearch/loopback-only.cjs`, loaded through `NODE_OPTIONS=--require=...` |
| REST daemon (unchanged) | `open-websearch.service` on `127.0.0.1:3210`, used by the `open-websearch` CLI and skill; it does not serve MCP |

Client entries: Claude user-scope `http` server (`claude mcp add --transport http -s user open-websearch http://127.0.0.1:3211/mcp`), codex `url = ...` under `[mcp_servers.open-websearch]`, pi `{"url": ..., "enabled": true, "directTools": true}` in `~/.pi/agent/mcp.json`.

## Why loopback needs a shim

`open-websearch` hardcodes `app.listen(PORT, '0.0.0.0')` and has no authentication. Under `networkingMode=mirrored` the WSL VM shares the Windows LAN address, so the unmodified service would offer an unauthenticated search and web-fetch tool to the LAN. The shim rewrites an explicit-host `net.Server.listen` to `127.0.0.1`. Verify after any `open-websearch` upgrade:

```bash
ss -ltn | grep 3211        # must show 127.0.0.1:3211, never 0.0.0.0 or *
```

## Why not 1MCP

Aggregating it behind 1MCP was tried first and rolled back:

- Clients going through `1mcp proxy` see renamed tools (`open-websearch_1mcp_search`), breaking native-name references.
- The local CLI needs a bearer token, which needs a first admin account created in the 1MCP admin console. `admin.enabled = true` with zero accounts leaves that console claimable by any local process, so it was reverted to `false`.
- 1MCP also runs in cold-start mode, which made the restart step non-trivial; see [Troubleshooting](../troubleshooting.md#1mcp-does-not-come-back-after-killing-its-process-cold-start-mode).

## Operations

```bash
systemctl --user status open-websearch-mcp
systemctl --user restart open-websearch-mcp     # clients reconnect on next call
```

Existing stdio copies persist until their client restarts. The service is a single process: if it dies, every client loses the tool until `Restart=on-failure` revives it (about 5 seconds). Rollback: `systemctl --user disable --now open-websearch-mcp` and restore the per-client `*.bak-ows-*` configs.

The one-off helper used for the 1MCP attempt, `~/.local/state/mcp-dev-bridge/apply-1mcp-aggregation.sh`, is cold-start aware (`--check`, `--apply`, `--verify`, `--rollback`) and is a reference for restarting 1MCP safely.
