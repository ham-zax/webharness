# WebHarness efficiency experiment

## Authorized outcome

Measure agent inputs, outputs, context cost, and HTTP behavior with OpenCode and
`zengate/deepseek-v4.1-flash-free` at maximum reasoning. Repair measured code
defects. Then compare instruction candidates using a Harness²-style
propose/probe/compose cycle. This is a local adaptation, not a reproduction of
the published benchmark or a claim of a globally optimal harness.

## Baseline and constraints

Starting commit: `cb3eb4a043ccdc177eacadac1cd5c6d44e04a03c`.
The initial checkout was clean. Parent documentation changes now describe the
pending code fixes. Read-set: README.md, docs/development.md,
docs/compatibility.md, docs/websession-clients.md, Dev and Local provider
instructions, browser memory authoring, skill retrieval, WebSession core,
protocol, server, Python and shell clients, and existing adapter tests.

Initial evidence: `/tmp/webharness-efficiency-baseline-20261025.md`.
The baseline used actual Dev and HTTP processes with isolated fixtures, a fake
Local backend, and one real OpenCode-selected MCP call. It did not qualify
Cloudflare, public OAuth, the live workstation, or browser behavior.

Preserve confirmation, nonce protection, uncertain-outcome handling, result
reconstruction, pagination, and authorization. Do not remove compatibility
fields merely to shrink envelopes. Run heavy jobs sequentially on the 7 GB host.

## Code repair slice

Worker owns WebSession core.mjs, client.py, protocol-store.test.mjs, and
discovery-client.test.mjs in an isolated worktree. Preserve structured results,
bound Python CLI output to 8192 payload bytes with private full-result files,
and use supported long polling. Parent reviews and integrates the exact diff.
TDD route: skipped strict sequencing, no user request for strict TDD. Add
behavioral regression checks and measure before/after on fixed inputs.

## Instruction experiment

Use the same code version across all instruction candidates. Start from current
WebHarness guidance, not empty instructions. Use isolated temporary workspaces,
local fixture data, and actual WebHarness providers/adapter. Preserve all raw
traces privately. Distinguish fixture backend traffic from actual agent choices.

Use two development tasks: one focused MCP workflow and one HTTP workflow.
Run a reference, a general-guidance candidate, a domain-guidance candidate, and
a composition on each task. DeepSeek creates candidates from task trajectories
without access to the expected answers or grader outputs. Record instructions
and their hashes. Keep one fixed model and reasoning setting.

Then run the reference and composition on two separate tasks, with two repeats
per task. Maximum: 16 solver runs and three editor calls. Stop and report model
or infrastructure failures instead of silently replacing models or fixtures.
Do not tune candidates against the separate tasks.

Measure task correctness, actual tool-call count, model-visible output bytes,
MCP/HTTP wire bytes separately, elapsed time, instruction bytes, and token usage
only when the model runtime reports it. No bytes-to-token estimate counts as
measured usage. Keep requests and outputs inspectable without credentials.

## Adoption and completion

Correctness is required. Prefer lower total model-visible context bytes among
correct candidates. Include instruction size in that comparison. Treat timings
as local samples, not production latency. Keep the baseline if the composition
regresses correctness or lacks a demonstrated context benefit on separate tasks.
Actual runtime token usage takes precedence over the limited byte proxy when
the two disagree. A smaller instruction file is not sufficient for adoption.
Integrate only guidance justified by evidence into its existing owner. An
inconclusive result does not authorize a new runtime optimization subsystem.

Review all diffs. Run targeted tests, the full portable gate once, and relevant
HTTP probes. Report measured changes, retained baseline behavior, limitations,
and remaining work. No live deployment or public benchmark claim is in scope.

## Results and parent decision

The instruction experiment completed 16 valid trials across four fixture tasks.
All valid answers passed. Seven additional solver attempts failed because the
temporary HTTP fixture processes stopped. Two editor attempts failed before
producing text. Development runs sometimes overlapped despite the sequential
brief. Some development HTTP wire counts therefore share a trace. Those counts
and cross-phase timings cannot establish a gain. Raw evidence remains under
`/tmp/webharness-instruction-experiment-20261025/`.

On separate tasks, two repeats per path and variant, the composition reduced
instruction-plus-output bytes from 105126 to 89056, a 15.3% reduction. However,
runtime input-token usage increased. These totals come from recorded
`step_finish.part.tokens` events, not byte estimates:

| Path | Variant | Uncached input | Cache-read input | Output | Reasoning |
| --- | --- | ---: | ---: | ---: | ---: |
| MCP | baseline | 31862 | 162816 | 1175 | 3257 |
| MCP | composition | 34681 | 187520 | 1053 | 4647 |
| HTTP | baseline | 24483 | 239744 | 3141 | 2555 |
| HTTP | composition | 24213 | 281088 | 3414 | 4732 |

Parent decision: reject the composed guidance. Keep existing MCP guidance and
provider code. MCP uncached input grew 8.8% and cache-read input grew 15.2%.
HTTP cache-read input also grew. Both paths took longer in these small samples.
The composition's blanket no-mutation rule and advice to skip discovery are
specific to the fixtures and cannot replace normal workstation policy or schema
inspection. The experiment did not establish a general MCP efficiency gain.

Retain the code repairs independently: HTTP structured-result preservation,
bounded Python CLI output with private full-result files, and long polling.
The worker's local median-of-three fixture measured 102401 to 8328 displayed
bytes for a 100 KiB result. A separate fixture reported 1.555 to 0.686 seconds
with a 0.6-second delay. Independent review found that the real adapter's old
1900 ms fast wait would already return that result inline. That timing is a
fixture-only observation and does not establish a real-adapter speedup.
The display reduction does not measure transfer savings or total model context.
The parent adjusted polling to share the deadline with
the initial POST. The existing 120-second transport timeout is separate from
the polling budget and is not a strict total wall-clock guarantee.

The initial 33 adapter tests and portable gate passed. Independent review then
found response-loss and save-failure recovery risks. The parent changed creation
to `wait=0` followed by status long polling, added unknown-outcome warnings,
preserved bounded output when saving fails, and rejected unsupported states.
New tests cover those failures, the polling deadline, final zero-second hold,
`sh` truncation, and structured data through the real adapter. A second review
identified ambiguous HTTP 5xx responses, truncated bodies, and malformed
snapshots. The parent routed these through unknown-outcome handling and added
tests that assert a single submission. Definite 4xx failures remain distinct.
Malformed status and chunk responses stop without repeating the tool.
Final validation: all 42 adapter tests passed, and `bash scripts/test-all.sh`
passed after the last code repairs. Documentation links and whitespace checks
passed. Experiment shell scripts passed ShellCheck. The two independent review
rounds supplied the recovery cases above; parent regression tests check the
repairs. No live 1MCP, Cloudflare, OAuth, browser, or deployment qualification
was performed. Task scope is complete with the negative MCP result recorded.
