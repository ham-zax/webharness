# Security Policy

WebHarness exposes development capabilities on the Linux account that runs it. Security issues that could escape the documented workspace boundary, bypass the selected trust profile, disclose credentials/state, or weaken the authentication/lifecycle boundary are considered high priority.

## Supported release

Security fixes currently target the latest public beta on `main`.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability reporting when enabled for the repository, or contact the maintainer privately through the repository's published contact channel.

Include the affected version/commit, deployment profile, reproduction steps, observed impact, and any suggested mitigation. Avoid including real credentials, tokens, private keys, or unrelated user data in the report.

## Security model

The concise threat/authority model lives in [docs/security.md](docs/security.md). In particular, `trusted-dev` Bash is intentionally not sandboxed, while `restricted` exposes only workspace-confined Read/Edit/Write primitives.
