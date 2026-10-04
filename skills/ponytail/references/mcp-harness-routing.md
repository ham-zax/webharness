# MCP Harness routing for Ponytail

Use this adapter only when the user's target is the connected WSL/Linux machine or the user explicitly invokes `wsl-web-harness`. It is not required for ordinary pasted-code work, public-web research, or files that are not on that machine.

## Mandatory order

1. Apply Causal Coding before source mutation and Ponytail before choosing the implementation shape.
2. Load `mcp-harness-router` and follow its current routing rules.
3. Inspect the real WSL repository before choosing a solution. Prefer literal search plus focused reads for ordinary discovery.
4. Apply the Ponytail ladder and choose the smallest correct change.
5. Mutate with the router-selected `wsl-web-harness` primitive.
6. Re-read or inspect the result. Follow Causal Coding for candidate-final checks; do not run tests unless independently authorized by the user, authoritative specification, or mandatory repository policy.

Do not treat Ponytail as a review pass that runs after implementation. The point is to prevent unnecessary code from being written in the first place.

## Mutation routing

Defer to the loaded MCP Harness Router if its rules differ from this summary. The expected routing is:

- Focused known file/range read -> `wsl-web-harness` read.
- Literal search, Git inspection, or another bounded command -> `wsl-web-harness` bash; prefer `rg` for repository search.
- Existing-text mutation -> guarded `wsl-web-harness` edit. If the anchor is unknown, inspect/search first and widen context until the intended match is unique.
- Syntax-shaped discovery or deterministic codemod -> ast-grep through `bash`; normally apply the final bounded mutation through guarded `edit`.
- New standalone text file -> `wsl-web-harness` write.
- Move or delete an existing regular file -> `wsl-web-harness` file operations.
- Existing authoritative `.patch`/`.diff` artifact -> `bash` with native `git apply --check` followed by `git apply`; do not manufacture patch artifacts for routine edits.
- Known symbol definition -> code symbol lookup when CodeDB-backed intelligence is worth its cost.
- Semantic exploration -> code search/context when needed; on a large unfamiliar repo, start with `bash` + `rg` + focused read.
- Persistent or interactive process -> the harness Terminal tools.
- Readiness/process/file/HTTP/systemd/timer condition -> the harness wait tool, not polling loops.

Use the concrete function schemas exposed in the current session. Do not guess generated tool names and do not search the public web for internal MCP function names.

## Authority boundary

When WSL is the target, `wsl-web-harness` is authoritative for repository state, files, Git, processes, and timestamps. Do not substitute the ChatGPT container, Python runtime, conversation Files, or public-web copies for those facts.

After a mutation, use a small observable WSL result such as a focused re-read, diff, or status check before claiming the change is applied or committed. Never claim `tested` or `green` unless testing was independently authorized and actually run.

## Human and terminal boundary

Do not bypass human ownership of a collaborative harness Terminal through Bash, raw tmux, or alternate shell access. Use the Terminal handoff/yield workflow when human input is required.

Ponytail does not need statusline hooks, hidden mode files, or persistent harness processes. The adapter exists solely to make the minimal-code policy operate through the connected machine's real repository primitives.
