# Personal Linux CLI Toolbox

The personal harness deliberately keeps common CLI utilities out of the MCP action catalog. Use them through native Bash so the model-facing tool surface stays small.

## Check the toolbox

```bash
scripts/check-personal-toolbox.sh
```

Install/repair the qualified user-level toolbox:

```bash
scripts/setup-personal-toolbox.sh
```

The normal personal WSL bootstrap runs this qualification automatically. Use the standalone command when inspecting or repairing the toolbox independently.

## Required capabilities

The checker qualifies the normal development baseline, including:

```text
git rg jq sed awk grep find
node (>=24.0.0) npm pnpm corepack
python3 uv
systemctl journalctl tmux
ast-grep
```

Optional conveniences include `fd` and `bat`.

## Usage policy

Prefer the tool that makes the local task clearer, but keep execution inside native Bash:

```bash
rg 'pattern' src
ast-grep run --pattern 'console.log($A)' src
jq '.key' data.json
fd package.json
```

Do not add a new MCP action merely because a useful CLI exists.


## Installation policy

The setup script uses user-level installation paths and refuses unsafe packaging shortcuts. It does not silently replace already-qualified system tools. The toolbox test suite covers version qualification, optional gaps, and idempotent setup behavior.
