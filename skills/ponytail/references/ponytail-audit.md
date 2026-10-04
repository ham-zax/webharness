# Ponytail Audit

Run Ponytail Review repo-wide. Scan the whole available codebase instead of a diff. Rank findings biggest cut first.

Use the same tags as Ponytail Review:

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing the standard library ships. Name the function.
- `native:` dependency or code doing what the platform already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.

Hunt dependencies the stdlib or platform already ships, single-implementation interfaces, factories with one product, wrappers that only delegate, files exporting one thing, dead flags/config, and hand-rolled stdlib.

Output one line per finding, ranked: `<tag> <what to cut>. <replacement>. [path]`.
End with `net: -<N> lines, -<M> deps possible.` Nothing to cut: `Lean already. Ship.`

Scope: over-engineering and complexity only. Correctness, security, and performance are out of scope. Report only; do not apply fixes.
