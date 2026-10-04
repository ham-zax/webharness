# Ponytail Debt

Harvest every deliberate Ponytail shortcut marked with a `ponytail:` comment into a debt ledger. Read/report only unless the user explicitly asks to persist the ledger.

## Scan

Search the available repository for comment markers, skipping dependency, VCS, and build-output directories. If a shell is available, an appropriate baseline is:

`grep -rnE '(#|//) ?ponytail:' .`

Add other comment prefixes when the stack uses them. Use the environment's repository/file search tools when shell access is unavailable.

Each hit is one ledger row. The comment prefix keeps prose that merely mentions the convention out of the ledger.

## Output

Group by file, one row per marker:

`<file>:<line>, <what was simplified>. ceiling: <the limit named>. upgrade: <the trigger to revisit>.`

The convention is `ponytail: <ceiling>, <upgrade path>`. Pull the ceiling and trigger from the comment. If the user asks for an owner, use blame/history tooling when available.

Any marker with no upgrade trigger gets a `no-trigger` tag.

End with `<N> markers, <M> with no trigger.` Nothing found: `No ponytail: debt. Clean ledger.`
