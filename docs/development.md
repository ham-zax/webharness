# Development

## Repository layout

```text
bin/                 WebHarness operator, lifecycle, extension, and Terminal entrypoints
lib/bridge/          lifecycle/process supervision internals
providers/pi-dev/    Dev read/edit/write/file_ops/Bash/wait provider
providers/code-router/ Code facade + rooted CodeDB router
providers/terminal/  Terminal MCP, broker, tmux/transcript logic
providers/browser/   Chrome DevTools facade + resource-local child routing
providers/browser-fast/ compact observe/execute facade over Agent Browser on Windows + Linux
providers/local-tools/ stable Local tool broker over inner 1MCP
providers/legacy-shell/ restricted-profile legacy shell
extensions/          engineering-checkout domain packs; the public reference ships generic extension machinery but excludes these machine/domain-specific packs
config/              tracked templates and trust profiles
scripts/             setup, doctor, rendering, publication staging, toolbox, installers
systemd/             user-service templates
tests/               root integration/publication/lifecycle contracts
docs/                current documentation
docs/history/        non-current engineering evidence
```

## Provider dependency setup

Fresh linked worktrees do not inherit ignored `node_modules`. Install pinned dependencies before running provider-aware root tests:

```bash
npm --prefix providers/pi-dev ci --omit=dev
npm --prefix providers/terminal ci --omit=dev
npm --prefix providers/code-router ci --omit=dev
npm --prefix providers/browser ci --omit=dev
npm --prefix providers/browser-fast ci --omit=dev
npm --prefix providers/local-tools ci --omit=dev
```

## Portable verification

```bash
bash tests/harness.sh
bash tests/publication.sh
bash tests/lifecycle.sh
(cd providers/pi-dev && npm test)
(cd providers/terminal && npm test)
(cd providers/code-router && npm test)
(cd providers/browser && npm test)
(cd providers/browser-fast && npm test)
(cd providers/local-tools && npm test)
node scripts/check-doc-links.mjs
bash -n bin/* lib/bridge/*.sh scripts/*.sh tests/*.sh
node --check scripts/*.mjs providers/pi-dev/*.mjs providers/terminal/*.mjs providers/code-router/*.mjs providers/browser/*.mjs providers/browser-fast/*.mjs providers/local-tools/*.mjs
git diff --check
```

This is the repository-required portable gate and is the CI boundary. It must not depend on live Cloudflare credentials, ChatGPT OAuth, actual linger changes, Windows Chrome automation, or WSLg GUI launches.

If a single MCP Bash request risks exceeding the connector request window, run the long suite inside a durable Terminal session and use `wait`/`terminal_read` for completion evidence.

## Maintained WSL reference qualification

Portable checks cannot prove the live Personal Workstation. On the qualified WSL2 reference machine, additionally run:

```bash
bash scripts/check-personal-toolbox.sh
webharness doctor --profile personal
webharness status
```

Then complete the harmless Dev/Code/Terminal/Local, Terminal-restart-survival, Local browser discovery, and public OAuth/endpoint checks in [Acceptance](acceptance.md). These are reference-machine qualification steps, not portable CI.

## Change boundaries

- Smaller profile behavior must not accidentally inherit Personal Workstation authority.
- Do not expose the raw CodeDB tool catalog.
- Do not make tmux lifetime depend on the broker or 1MCP.
- Keep `wait` durable and separate from the normal Terminal model-read cursor.
- Keep native Bash as the authoritative execution path.
- Preserve provider-internal same-canonical-path mutation serialization.

## Documentation

Current public docs describe current behavior and reference-environment constraints. Engineering chronology, benchmarks, broad plans, agent coordination, and superseded acceptance procedures remain outside the public reference distribution.

When moving an important old doc path, leave a small compatibility pointer rather than duplicated stale guidance.

For documentation-only work, keep the edit loop lightweight: check local Markdown links, stale paths/wording, and `git diff --check` while writing. Run the full repository gate once before merge; do not create RED/GREEN tests for prose wording or rerun provider suites after every documentation edit.

## Public classification and promotion

`scripts/public-paths.sh` is the single source of truth for the public reference distribution. `tests/publication.sh` consumes it for validation, and `scripts/stage-public.sh` consumes the same classifier for release staging. Do not maintain a second allow/deny list in release tooling.

The public reference includes the generic Personal Workstation implementation, generic extension machinery, the inactive vendored Chat-on-Steroids extension snapshot, and the Agents follow-on plan. It excludes engineering history/experiments, broad tracked Skills, machine/domain-specific extension packs, the optional WebSession HTTP adapter, and machine-local/runtime state.

Promotion into the independent public repository is:

```bash
scripts/stage-public.sh --destination "$HOME/repo/webharness"
```

The destination must be a clean existing Git repository. Staging preserves its `.git/` directory, replaces only working-tree content, and never copies source Git history.

## Release checklist

1. run the portable verification gate in the source checkout;
2. commit the coherent source result and ensure the source working tree is clean;
3. stage into the clean independent public repository using `scripts/stage-public.sh`;
4. run the same portable gate in the staged public repository and inspect its complete diff;
5. commit the public repository as one coherent reference update;
6. on the maintained WSL machine, rerender source paths from the public checkout without moving OAuth/browser/state/tmux identities;
7. restart only components whose executable/config source changed, preserving tmux lifetime;
8. complete [Acceptance](acceptance.md), including `webharness status` and public endpoint/OAuth evidence;
9. create tags/releases only at a known-good public commit.

## Dependency upgrades

Treat 1MCP, Pi coding primitives, MCP SDK/Zod, CodeDB, tmux behavior, and the legacy restricted-shell dependency as qualified pins. Upgrade intentionally and rerun the relevant provider, lifecycle, OAuth, and product-path acceptance.
