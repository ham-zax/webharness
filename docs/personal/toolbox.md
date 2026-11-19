# Linux CLI Toolbox (Personal & Headless)

WebHarness deliberately keeps common CLI utilities out of the MCP action catalog. Use them through Dev `exec` (or Bash when shell syntax is needed) so the model-facing tool surface stays compact.

## Check or install the toolbox

Check the personal workstation toolbox (WSL2/Ubuntu):

```bash
scripts/check-personal-toolbox.sh
```

Check the minimal headless server toolbox (ARM64 or x86_64 Linux):

```bash
scripts/check-personal-toolbox.sh --headless
```

Install or repair missing/outdated tools at the user level:

```bash
scripts/setup-personal-toolbox.sh            # personal workstation
scripts/setup-personal-toolbox.sh --headless # headless server (guards sudo -n)
```

`webharness setup --profile personal` and `webharness setup --profile server` run the corresponding qualification automatically. Use the standalone scripts when inspecting or repairing the toolbox independently.

## Required vs. optional tiers

### Personal workstation (default)

- **Required baseline:** `git`, `rg`, `jq`, `sed`, `awk`, `grep`, `find`, `node` (`>= 24.0.0`), `npm`, `pnpm`, `corepack`, `python3`, `uv`, `systemctl`, `journalctl`, `tmux` (`>= 3.4`), `ast-grep` (`= 0.45.0`).
- **Optional accelerators (best-effort):** `fd`, `bat`, `yq`, `pueue`, `pueued`, `difft`, `just`, `scc`, `hyperfine`, `mcp-inspector`.

### Headless server (`--headless`)

- **Required core:** `git`, `rg`, `jq`, `node` (`>= 24.0.0`), `tmux` (`>= 3.4`).
- **Optional accelerators (best-effort):** `ast-grep` (`= 0.45.0`), `fd`, `yq`, `pueue`, `pueued`, `difft`, `just`, `scc`, `hyperfine`, `mcp-inspector`.

Missing optional tools are reported as optional gaps rather than failing qualification.

## Usage policy

Prefer the tool that makes the local task clearer, invoked through Dev `exec` (or `just` recipes) rather than adding one-off MCP tools:

```bash
rg 'pattern' src
ast-grep run --pattern 'console.log($A)' src
jq '.key' data.json
fd package.json
just host-audit
```

When `pueued` is installed, `scripts/install-pueued-user.sh` configures a user-systemd `pueued.service` (`parallel=1`) so long builds and test suites run outside `mcp-dev-bridge.service` and survive bridge restarts.

## Installation policy

- **Idempotent (never installs twice):** The setup script checks existing executables and versions first and skips any tool that already satisfies the requirement; it does not silently replace already-qualified system tools.
- **Verified user-level installs:** GitHub release binaries are SHA-256 verified, `mcp-inspector` installs with `--ignore-scripts`, and `--headless` guards privileged calls with non-interactive `sudo -n` so headless servers never hang on a password prompt.
- Covered by `tests/personal-toolbox.sh` for version qualification, optional gaps, and idempotency.
