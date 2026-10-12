# Import an installed skill collection

Copy this prompt into an agent working in the target WebHarness checkout. It is
a task template, not an instruction to execute merely because this file is read.
Paths are generic so it can be reused on another machine.

```text
In this WebHarness checkout, replicate my currently installed Codex skills into
the native WebHarness skill library. Read AGENTS.md and docs/skill-library.md,
use Aegis, and work solo through implementation, verification, and a local commit.

Inventory the configured Codex skill installation (usually ~/.codex/skills),
installed plugin skills, and referenced specialist collections. Resolve symlinks
and copy complete packages as real files, preserving original instructions,
helpers, references, and assets. Leave existing skills/ and agents/skills/ unchanged.

Judge compatibility by capabilities available to ChatGPT through WebHarness.
WSL scripts, tools, filesystem access, and browsers are valid dependencies.
Exclude only skills that require unavailable capabilities; document every exclusion.

Bundle required dependencies without relying on the original installations,
other repository checkouts, JevShelf, or Skillshare at runtime. Preserve original
payloads; document adaptations separately. Replace JevShelf-dependent routing
with native discovery where needed.

Keep readable-file policy explicit, metadata generated, revisions dependency-wide,
and completeness separate from tested compatibility. Preserve invocation
restrictions. Never import credentials or personal runtime state.

Verify source hashes, references, representative workflows, Local MCP
discovery/reads, and relocation without the original installations. Run repository
checks and review the diff.

Report the commit, included/excluded counts, adaptations, tests, and limitations.
Do not publish or change live deployment configuration.
```
