# Ponytail Help

Display this card when invoked. One-shot; do not change mode unless the user also asks to change it.

## Levels

| Level | Trigger | What changes |
|---|---|---|
| **Lite** | `/ponytail lite` | Build what's asked, name the lazier alternative in one line. |
| **Full** | `/ponytail` | YAGNI -> existing code -> stdlib -> native -> existing dependency -> one line -> minimum. Default. |
| **Ultra** | `/ponytail ultra` | YAGNI extremist. Deletion before addition. Challenges unnecessary requirements while honoring explicit ones. |

The selected level is conversational state, not a host plugin flag. It can persist within the current conversation when context is available.

## Modes

| Mode | Trigger | What it does |
|---|---|---|
| **ponytail** | `/ponytail` | Lazy mode itself. Simplest solution that works. |
| **ponytail-review** | `/ponytail-review` | Over-engineering review of a diff. |
| **ponytail-audit** | `/ponytail-audit` | Whole-repo over-engineering audit. |
| **ponytail-debt** | `/ponytail-debt` | Harvest `ponytail:` shortcut comments into a ledger. |
| **ponytail-gain** | `/ponytail-gain` | Published benchmark-impact scoreboard. |
| **ponytail-help** | `/ponytail-help` | This card. |

## Deactivate

Say `stop ponytail`, `/ponytail off`, or `normal mode`. Resume with `/ponytail` or another level.

## ChatGPT compatibility

The upstream Claude/Codex adapters also provide lifecycle hooks, filesystem config, statusline behavior, and plugin update commands. ChatGPT Skills do not expose those mechanisms. This port preserves the six portable behaviors using skill invocation plus conversation context, without writing mode files or claiming cross-session activation.
