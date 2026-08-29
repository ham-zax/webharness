# Reference Environment

WebHarness is published as a reproducible reference implementation, not as a promise of broad host compatibility. The maintained deployment is qualified on this environment:

- WSL2 with Ubuntu on x86_64;
- Node.js 24 or newer;
- a systemd user manager inside WSL;
- WSLg for headed Linux browser capability;
- tmux for durable Terminal PTYs;
- Cloudflare Tunnel plus 1MCP 0.36.0 for the demonstrated public MCP transport.

Run `webharness doctor --profile personal` before setup. Doctor validates the deployment templates without writing generated state and reports which reference assumptions already hold.

## Personal Workstation assumptions

The `personal` profile is the full reference deployment. Its setup path qualifies a Linux CLI toolbox and installs pinned provider/runtime dependencies used by Dev, Code, Terminal, Local, Browser, and Browser DevTools. `scripts/check-personal-toolbox.sh` records the current command/version assumptions.

The reference bootstrap currently owns a globally installed pinned 1MCP runtime and applies two source-level compatibility patches to that package. This is an implementation constraint, not a recommended packaging model for every fork. Do not run the reference bootstrap on a machine where another deployment must independently control the same global 1MCP installation without first changing that ownership model.

`--enable-startup` is an explicit consent boundary. Without it, setup renders configuration and installs dependencies but does not enable linger or persistent user services.

## Browser ownership

Windows and Linux browser state are intentionally separate.

On Windows, WebHarness launches or reuses a dedicated visible Chrome profile at:

```text
%LOCALAPPDATA%\mcp-dev-bridge\chrome-profile
```

Chrome chooses an ephemeral loopback DevTools port through `DevToolsActivePort`. `browser-fast` uses Agent Browser for routine interaction; `browser-devtools` connects the Chrome DevTools MCP facade to the same dedicated profile. Everyday Chrome is not attached or copied.

On Linux/WSLg, `browser-fast` uses the current user configuration at `~/.config/mcp-dev-bridge/browser-fast.json`. The maintained Personal Workstation can use managed Chrome or a managed Clearcote profile. Browser DevTools uses the Linux Chrome DevTools path when callers pass `browser_target="linux"`.

## What is not qualified

The current repository does not claim native macOS support, native Windows-host deployment, non-WSL Linux parity, ARM64 parity, or universal distro/package-manager support. A fork can adapt those choices, but it should re-qualify lifecycle, browser ownership, Terminal persistence, transport, and dependency installation rather than treating this document as a compatibility guarantee.

Optional Windows Chrome integration also depends on WSL-to-Windows process/filesystem interop. WSLg is required only for the headed Linux browser path; it is not required for the dedicated Windows Chrome path.
