# Security and Trust Model

WebHarness has two explicit authority levels. Choose based on what the Linux account and workspace are allowed to contain.

## `restricted`: workspace-confined files

`restricted` exposes only Read, Edit, and Write.

The file boundary is designed to keep these primitives workspace-confined:

- tool paths must be relative;
- absolute paths are rejected;
- `..` traversal is rejected;
- existing paths are canonicalized before access;
- symlink escapes outside the workspace are rejected;
- new files require an existing canonical parent inside the workspace;
- Write is exclusive/create-only rather than overwrite-by-default;
- Edit requires exact unique text and detects concurrent file changes before writing.

This is a file-access boundary, not a container or operating-system sandbox.

## `trusted-dev`: Linux service user authority

`trusted-dev` adds Bash.

Bash is intentionally unrestricted and runs with the effective permissions of the **Linux service user** running the bridge. That can include repositories outside the configured workspace, network access, developer credentials, package managers, local processes, and user systemd services if that account can normally access them.

Use this profile only on a machine/account where that authority is intentional.

## Authentication and identity perimeter

The pinned 1MCP server implements MCP OAuth authorization and bearer-token validation. Its consent flow determines what an OAuth client is authorized to access; it is **not by itself a human identity perimeter** that proves the person approving the flow is the machine owner, an employee, or a tenant.

Do not expose a development machine to arbitrary internet users and assume the 1MCP consent page is sufficient identity authentication. Put the endpoint behind an authenticated access boundary appropriate to your deployment and current ChatGPT MCP connectivity model.

## OAuth session lifetime

The pinned 1MCP release uses finite-lived access-token sessions. Its OAuth server does not implement **refresh token** exchange, so an expired authorization can require the ChatGPT connection to authenticate again. Treat this as a public-beta runtime limitation rather than promising unattended permanent connectivity.

## Not a multi-user SaaS boundary

This project is a self-hosted developer bridge. It is not designed as a **multi-user SaaS** tenancy/isolation layer. A hosted service would need separate customer identity, tenant isolation, resource ownership, authorization policy, abuse controls, and operational boundaries.

## Local state

Keep the external bridge state directory private. It may contain generated 1MCP configuration, OAuth/session records, and full Bash output retained after model-visible truncation.

Never commit `.env`, state/session directories, logs containing user requests, or credentials into the repository.
