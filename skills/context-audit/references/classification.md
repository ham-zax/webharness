# Finding classification

Use these categories:

- Conflict: two instructions require incompatible behavior.
- Duplicate: same rule exists in multiple layers; keep it closest to the point of use.
- Obvious: context spends tokens stating behavior already unambiguous from code/tooling.
- Judgment-now: a blanket rule prevents a capable agent from making safe local decisions.
- Gotcha: non-obvious, repo-specific, load-bearing guidance that should remain.
- Stale: names an unavailable tool, old path, old architecture, or superseded workflow.
- Trigger collision: multiple skills are likely to activate for the same request without a clear priority.
- Missing boundary: the harness says what to do but not how far the agent may go.
- Missing autonomy: the harness forces unnecessary approval for low-risk implementation choices.

For every proposed deletion, state what behavior would be lost if the rule were actually load-bearing.
