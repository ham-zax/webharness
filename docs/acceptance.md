# Reference Qualification

WebHarness has two validation layers. The portable repository gate proves source contracts without depending on a live workstation. This checklist qualifies the maintained WSL reference deployment and must be run on that machine after a public-source promotion or a material runtime change.

## 1. Portable source gate

Run the exact portable gate in [Development](development.md) in both the source checkout and the staged public checkout. It must pass without live Cloudflare credentials, ChatGPT OAuth, Windows Chrome automation, WSLg GUI launches, or changes to user linger.

## 2. Reference environment and rendered state

From the canonical public checkout:

```bash
bash scripts/check-personal-toolbox.sh
webharness doctor --profile personal
webharness status
```

Required evidence:

- doctor reports no failures;
- the rendered source root is the canonical public checkout;
- generated state remains current-user-owned with restrictive modes;
- `webharness status` reports local/public health and `issues: 0`;
- the existing `mcp-dev-bridge`, `wsl-agent-*`, state-root, and browser-profile identifiers remain unchanged unless a separately authorized migration changed them.

## 3. Harmless capability calls

Use the live MCP connection and exercise each public capability boundary without destructive or consequential work:

- **Dev:** read a known repository file or run a bounded `pwd`/Git inspection.
- **Code:** resolve a known symbol or obtain bounded repository context from the canonical public checkout.
- **Terminal:** open a named shell session, print a harmless marker, and read it back.
- **Local:** list/discover downstream tools with a bounded query.

Record the observed results in the release/commit notes or operator log; do not write credentials into the repository.

## 4. Terminal lifetime across bridge restart

With the harmless Terminal session from the previous step still alive:

1. record the tmux/Terminal session identity;
2. restart only `mcp-dev-bridge.service` and, when its executable source changed, `wsl-agent-terminal-broker.service`;
3. do **not** restart `wsl-agent-tmux.service`;
4. list/read the same Terminal session again;
5. confirm its PTY/process survived the bridge/broker restart.

This proves the ownership invariant: tmux owns PTY lifetime; MCP/1MCP do not.

## 5. Local browser discovery

Through Local, confirm the live catalog contains both logical browser servers:

```text
browser-fast
browser-devtools
```

Load only one harmless schema from each. A GUI launch or website mutation is not required for this discovery check. When browser execution itself changed, separately exercise the target that changed under the operator's normal browser policy.

## 6. Public MCP/OAuth connectivity

From the maintained ChatGPT/MCP client:

- connect to the configured public MCP endpoint through Cloudflare;
- complete or reuse the expected OAuth grant;
- refresh the catalog and confirm the intended outer provider/tool surface is available;
- make one harmless authenticated tool call.

Do not copy authorization codes, tokens, cookies, or tunnel credentials into acceptance notes.

## 7. Promotion/cutover completion

Qualification is complete only when:

- the canonical `webharness` checkout is the independent public Git repository at the qualified commit;
- the live rendered `MCP_BRIDGE_ROOT` points to that checkout;
- the public checkout passes the portable gate;
- doctor/status and the harmless capability checks above pass;
- the pre-cutover Terminal session survives the required bridge/broker restart;
- no OAuth state, browser profile, state root, tmux namespace, or service name was migrated merely to change source checkout.

See [Development](development.md) for the public classifier/staging workflow and [Operations](operations.md#safe-source-cutover) for source-path cutover mechanics.
