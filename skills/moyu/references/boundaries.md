# Mission boundary matrix

| Situation | Default action |
| --- | --- |
| Choose internal algorithm or helper shape | decide autonomously |
| Edit another file required by the same behavior | proceed and report |
| Add/update tests explicitly required by the user/spec/repository policy | proceed, keep the test surface proportional |
| Testing is not explicitly authorized | do not add, modify, or run tests; use direct/non-test evidence instead |
| Documentation-only change with no executable contract | use lightweight artifact checks only when relevant; do not invent TDD |
| Small local refactor required to make the change safe | proceed if clearly necessary |
| Unnecessary worktree/setup/full-suite run with no concrete risk | omit it |
| Worktree needed for concurrent writers, conflicting local state, or material isolation | proceed when authorized by the workflow/user |
| Unrelated cleanup found nearby | do not do it; mention only if important |
| New external package/service | ask before proceeding |
| Public API or shared agent contract change | stop and coordinate |
| Persistent schema/migration strategy change not already approved | stop and coordinate |
| Auth/security/privacy semantics change | stop and coordinate |
| Another agent's owned mission surface | avoid editing; coordinate |
| Destructive reset/delete/force operation | require explicit approval |
| Broad architectural redesign | stop and propose the minimal options |

The purpose is high agency inside a bounded mission, not passive permission-seeking or mechanical process compliance.
