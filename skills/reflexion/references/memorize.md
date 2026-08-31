# Memorize Mode

Use this mode to convert reflection/critique outcomes into durable, reusable repository guidance.

This is project memory, not ChatGPT account memory.

## 1. Harvest candidate lessons

Sources may include:

- recent reflection findings;
- critique reports;
- verified bug root causes;
- failed approaches and why they failed;
- successful recurring solution patterns;
- API/tool usage constraints;
- repeatable verification gates;
- domain terminology or architecture constraints discovered from code/docs.

Extract only lessons likely to help future work.

## 2. Filter aggressively

A candidate lesson should be:

- **Relevant**: likely to recur in this repository or organization.
- **Evidence-backed**: supported by code, tests, docs, or repeated observation.
- **Atomic**: one rule or fact per bullet.
- **Actionable**: a future agent can apply it immediately.
- **Stable**: not merely today's line number, temporary branch, or one-off implementation detail.
- **Safe**: contains no secrets, tokens, private URLs, credentials, or unnecessary PII.

Reject vague guidance such as "write good code", personal style preferences, and unsupported numeric thresholds.

## 3. Choose the durable target

Respect repository conventions.

1. If the user names a target file/section, use it.
2. Otherwise inspect existing `AGENTS.md`, `CLAUDE.md`, and repository documentation/instructions.
3. Prefer the file the repository already treats as authoritative for agent guidance.
4. If both exist, follow their documented ownership and avoid duplicating the same rule in both.
5. If neither exists, ask before creating a new agent-instruction file unless the user's request explicitly authorized creating one.

Do not overwrite the whole file. Make a minimal targeted edit.

## 4. Grow and refine

For each lesson:

- search the target for an existing equivalent rule;
- merge or strengthen rather than duplicate;
- preserve more specific evidence-backed guidance when it conflicts with vague older text;
- flag true contradictions instead of silently choosing one;
- keep context and limits close to the rule.

A useful compact shape is:

```markdown
### <Pattern or constraint>
- When: <condition>
- Do: <specific action or decision rule>
- Verify: <observable check>
- Avoid: <known failure mode, if useful>
- Source: <spec/test/incident/date pointer when helpful>
```

Use plain bullets when the full shape would be unnecessary.

## 5. Dry-run versus write

If the user asks for a preview/dry-run, show proposed additions and target locations without editing files.

Otherwise, when the user explicitly asked to memorize/save the lesson, apply the minimal edit using available repository tools and then reread the edited area to verify coherence and non-duplication.

## 6. Validation

Before reporting success, check:

- no duplicate or contradictory rule was introduced;
- wording is specific enough to guide future behavior;
- facts and thresholds are supported;
- sensitive data was not copied;
- links/paths used as durable pointers are valid enough for the repository;
- the surrounding instruction file remains coherent.

Report what was added/changed and where.
