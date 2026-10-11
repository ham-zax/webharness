# Skill library

WebHarness ships a native read-only provider and 28 MIT-licensed thinking skills
under `skill-library/`. Source instructions, license, provenance, access policy
and generated catalog travel with the repository. JevShelf, Skillshare, TypeSafe
credentials, embeddings and hosted model calls are not required. Existing
`skills/` and `agents/skills/` are unchanged and are not implicitly exposed.

## Deployment and authorization

Personal and Server profiles include `server="skill-library"` behind Local.
Setup installs pinned dependencies; rerender an existing deployment to add the
route. Smaller profiles do not gain Local or library access. Outer Local
instructions advertise the route; discovery does not depend on an inner server's
initialization instructions reaching the client. Automatic activation remains
client-dependent. Explicit discovery uses `tool_list(server="skill-library")`.

Local is the existing powerful workstation authorization domain. A read-only
provider does **not** make a Local grant read-only. Skills-only clients require
a separate authenticated gateway/configuration containing this provider alone,
with distinct grants and no Dev/Local routes. Tool annotations do not enforce
that deployment requirement.

A standalone local stdio MCP configuration is:

```json
{
  "mcpServers": {
    "skill-library": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/webharness/providers/skill-library/server.mjs"]
    }
  }
}
```

Standalone exposes exactly two read-only tools. It provides no remote transport,
OAuth or public listener. Filesystem checks require the repository's Linux/WSL
runtime, including `/proc/self/fd`.

## Discover and read

1. Discover `tool_list(server="skill-library")`; inspect schemas as needed.
2. Call Local `tool_call` with `server="skill-library"`, `tool="find_skills"`.
3. Select useful candidates, respecting invocation hints and compatibility.
4. Call `read_skill` with the returned `id` and `revision`. Continue until
   `complete=true`, then read only needed identifiers from `readableFiles`.

Typical logical arguments:

```json
{"query":"thinking-pre-mortem","limit":3}
```

```json
{"id":"thinking/thinking-pre-mortem","revision":"<returned SHA-256>"}
```

`find_skills`: optional `query`, `collection`, `limit` (1..20, default 8) and
opaque `cursor`. Returns descriptions, counts, provenance, revisions, invocation
hints, completeness and compatibility without skill bodies. Omit query to browse
descriptions. Exact names are preferred; other queries use deterministic BM25
over names/descriptions. Results say `lexical` or `browse`, without semantic
confidence claims. Zero matches means no lexical candidates; broaden the query
or browse. The host can decide no skill is useful.

`read_skill`: required `id` and `revision`; optional `file`, `cursor`, `max_bytes`
(256..16384, default 8192). Files are approved pack-relative identifiers, never
arbitrary paths. Omit file for SKILL.md. Pages preserve UTF-8 boundaries.
Readable dependency metadata is capped at 8 KiB at validation.
Structured data is capped at 24 KiB including JSON escaping; the MCP envelope may
repeat that data in text and structured form. Incomplete pages have a next cursor.

Skill text and `allowed-tools` hints grant no authority and cannot override user
instructions or operator policy. Preserve `disable-model-invocation` and
`user-invocable` restrictions when applying skills. The bundled upstream skills
require explicit invocation; retrieving them does not permit auto-activation.
The provider never executes helpers or makes network/model calls.

## Explicit policy and generated metadata

`policy.json` contains reviewed access decisions: packs, source/license, skill
directories, exact readable files and separate compatibility declarations.
For example, a shared sibling reference is approved explicitly:

```json
{
  "id":"example",
  "directory":"example",
  "readable":["example/SKILL.md","shared/reference.md"],
  "compatibility":{
    "kind":"requires-tools",
    "requires":["some-tool"],
    "verification":"unverified"
  }
}
```

Directory traversal, symlinks (including ancestors), non-regular files and
undeclared files are rejected. Relative pack roots make exports relocatable.
Permissions are never derived from frontmatter or prose links. Operators must
review dependencies when declaring the readable set; automatic link parsing is
not proof that all operational dependencies were declared.

`catalog.json` contains reproducible names/descriptions, digests, sizes and
revisions. Editing it cannot approve a file. Runtime derives metadata from
policy and source files; discovery recomputes it without a watcher or cache.

Completeness means **all declared files are present and readable**. Compatibility
is a separate operator assertion: `instruction-only`, `requires-tools` or
`host-specific`, with `unverified`, `reviewed` or `tested` verification. Source
review does not prove an executable workflow works on this machine. The provider
does not claim to detect every implicit dependency.

A skill revision covers every readable file's bytes, its mappings, compatibility
and pack source/license declarations. Reference changes invalidate it even if
SKILL.md is unchanged. Reads verify the entire selected dependency set.
Discovery cursors bind to catalog revision and filters; read cursors bind to
skill, revision, file and offset. Checksums establish continuity, not trust.

## Operator commands and updates

```bash
./bin/webharness skills find --query thinking-first-principles
./bin/webharness skills find --collection thinking --limit 8
./bin/webharness skills read --id thinking/thinking-first-principles --revision RETURNED_SHA256
./bin/webharness skills check
./bin/webharness skills compile
./bin/webharness skills export --destination /new/path/skill-library
```

`compile` regenerates only metadata; it cannot add access permissions. `check`
validates declared files and compares the derived catalog byte-for-byte.
`export` creates a new destination with approved files, per-pack LICENSE and
PROVENANCE.md, policy and catalog. Those provenance files must be explicitly readable in each
exportable pack. It refuses existing destinations and copies no undeclared
files. A failed partial export is left for inspection. An export contains data;
the destination's WebHarness supplies the bundled native reader.

Use `--policy /path/to/policy.json` for an alternate library in the CLI, or
`MCP_SKILL_POLICY_FILE` on the standalone server. This is operator configuration,
not a remotely supplied tool argument.

Updates are explicit: review source changes, distribution terms, invocation
restrictions, dependencies and compatibility; update copies/policy; retain
license/provenance; compile; check; run portable tests. No installs, background
sync, JevShelf imports or automatic source rewrites occur. Restart the provider
after policy changes. OAuth and existing state identities need not change.

## Recovery and qualification

| Error | Recovery |
|---|---|
| `STALE_REVISION` | Rediscover and use the new revision |
| `STALE_CURSOR` | Restart discovery without a cursor |
| `POLICY_CHANGED` | Operator restarts the provider after policy review |
| `FILE_NOT_APPROVED` | Use a readableFiles identifier; permission updates are operator work |
| `MISSING_DEPENDENCY` | Restore or review the declared file; it is never silently omitted |
| `UNSAFE_FILE` | Replace symlinks/non-regular files with reviewed regular files |
| `INVALID_SKILL` | Review and fix malformed or ambiguous metadata |

Portable checks cover policy separation, invocation hints, missing/changed
references, traversal/symlinks, UTF-8 and JSON budgets, export relocation, real
stdio find/read and Local routing with its five-tool ABI. Real web-client
activation and OAuth grants need separate client qualification. Retrieval is not
evidence that a skill's advice improved an outcome.
