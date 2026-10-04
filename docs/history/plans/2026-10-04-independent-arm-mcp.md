# Independent ARM MCP deployment

## Outcome

Keep two independently selectable MCP connections: the existing WSL deployment and a new headless ARM deployment. Both run the same committed WebHarness version, with separate hostnames, Cloudflare tunnels, runtime state, credentials, and OAuth grants. No cross-machine provider is added to either catalog.

## Implementation

1. Keep the reviewed context reductions: quiet edits, bounded reads and command output, atomic overwrite, on-demand parameter names, and cursor-safe bounded Terminal reads. Set explicit output/read limits in the private WSL deployment environment.
2. Add a `server` trust profile for Linux servers. Reuse Dev, Local, Terminal, and existing lifecycle services. Exclude desktop/browser providers and WSL GUI requirements. Support user paths, persistent tmux, and owner-controlled local server additions.
3. Document headless installation and independent tunnel deployment. Public OAuth discovery, registration, authorization, and token exchange remain available; keep consent submission and OAuth management private on the new server, accessible through an SSH local forward. Preserve the public issuer during local approval.
4. Run the repository portable gate and inspect the final diff for unintended changes and private data. Repair a stale generated Skills manifest if needed to satisfy the required gate; do not change Skills content for this work.
5. Commit the source changes. Render and restart the existing WSL bridge and Terminal broker while retaining OAuth state and tmux sessions. Check local and public readiness.
6. Install the committed source on ARM with a separate tunnel and private environment/state. Install only required headless dependencies. Preserve the existing API gateway, Caddy routes, and application services.
7. Verify ARM discovery, access refusal without a token, private consent enforcement, the headless catalog, and persistent Terminal operation. Record the deployment in the private server inventory.

## Boundaries and completion

Do not commit deployment secrets or copy account-wide Cloudflare credentials to ARM. Do not rename or merge the current WSL connection. Future WSL-to-ARM MCP client access is outside this deployment.

Completion means the committed version is healthy on WSL and ARM, with the ARM URL ready for registration as a separate app. Final browser approval in ChatGPT or Claude is a human action using the owner's account. Report any deployment blocker explicitly rather than claiming an unverified launch.
