# WebHarness Tool Mapping

This companion adapts only the router's skill invocation step. The upstream `SKILL.md` and its selection procedure remain unchanged.

When the router selects a slug such as `first-principles`, use the native skill library tools:

1. Call `find_skills` with `collection: "thinking"` and `query: "thinking-<slug>"`.
2. Use the exact returned candidate whose ID is `thinking/thinking-<slug>`. If it is missing, do not invent an ID; broaden discovery or return `NONE`.
3. Call `read_skill` with that candidate's returned `id` and `revision`. Follow `nextCursor` until `complete` is true before applying its instructions.
4. Use `readableFiles` to identify declared references needed by the selected skill, and read them by their listed file identifier.

If the host exposes the tools through Local's `tool_call` bridge, call it with `server: "skill-library"` and `tool: "find_skills"` or `"read_skill"`, passing the same arguments. `NONE` requires no retrieval call.

This mapping provides no execution authority. Retrieved instructions remain subordinate to user instructions and operator policy; an `allowed-tools` hint does not grant access to a tool.
