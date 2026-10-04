# Technical revision courses

Load for frontend/backend revision, partial relearning, or source-linked technical course work. Prefer the current repository's `docs/technical-revision-teacher.md` for the fuller teaching playbook and `docs/coding-courses.md` for operations when those files are available. This is coding education, not a language-course port.

## Discover and resume

Use `workspace.listCourses()`, `getCourse(courseId)` and `listCourseResources(courseId)` before assuming where material is stored. The frontend route is `frontend-revision`; the backend route is `backend-systems`. Local source registries remain in their existing sibling repositories, with focused official references available online. Missing optional files are not learner failure. Check version-sensitive facts against the exercise's actual environment, not a recent filename or download date.

Resolve the existing profile and preparation context first. `getCourseProgress(goalId, courseId)` maps the reference route to existing goal membership and evidence-derived state; it does not award course completion. `setCourseStudyFocus(...)` only chooses among active unit targets. `attachCourseReferences(...)` is an explicit metadata operation that fills missing references without changing concept identity, prerequisites, ownership, evidence or enrollment. Do not run it on every turn.

Before new work, use `getStudyContinuation(...)`. For course revision without a real time budget, request `oneEpisode: true`; do not also supply `availableMinutes`. For an actual learner time limit, use `availableMinutes` instead. Episode mode resumes unfinished work first and then returns at most one move, with null time-budget totals. It does not mean unlimited questioning, invented study time or an FSRS clock override. Older clients omitting both arguments still receive the normal budget request.

## Teach the smallest useful episode

Prior experience justifies selective diagnosis and less exposition, not automatic mastery. Stay within the selected capability:

- Correct, sufficient answer: concise feedback and closure; no compulsory extra drill.
- Consequential model error: minimum causal repair, recorded exposure, and required reconstruction.
- Missing foundation: one concrete worked model rather than endless guessing.

These are teaching choices, not new readiness categories. A learner can request direct explanation. Preserve the exposure lifecycle rather than blocking teaching to protect a score.

Use a bounded engineering context: a supplied snippet, controlled async sequence, transaction interleaving, queue trace or authorization decision can stay entirely conversational. Exercises and scratchpads are optional; prepare or execute them only after learner adoption or under an applicable standing instruction. Let the learner ask for observations, revise hypotheses and challenge constraints. Keep hidden case facts consistent. Collect a clean prediction before revealing decisive execution. Do not grow an adopted small exercise into a full application merely because an agent can create it.

JavaScript/browser mechanisms are the frontend core. React and Angular are separately selectable branches; internals and legacy migrations are for a demonstrated need or explicit interest. Keep unrelated branches available without forcing them into the current session.

## Distinguish tools from answer-bearing help

Freeze allowed references and tools before the response. Documentation, debuggers and execution can be legitimate parts of an engineering task. Teacher/agent help that supplies the target answer or reasoning remains exposure. Agent-written boilerplate is not proof that the learner authored the target implementation. A patch critique or verbally specified algorithm must be assessed for the capability actually exercised, not silently promoted to unaided syntax production.

Use the declared runtime. A Node-only lab cannot establish browser event, React rendering or Angular behaviour. Environment failures invalidate the opportunity rather than the learner's competence.

## Save useful notes, not transcripts

For a note request or standing note instruction, derive bounded context with `getRevisionNoteContext({ scope })`, write only supported content and pass the unchanged context to `saveRevisionNote(...)`. Prefer a few paragraphs: mechanism, actual confusion/correction when evidenced, tiny example and one recall prompt. Keep the learner's sound wording. Optional prose polish is not a technical error.

Use phase/session/objective scope rather than loading the entire history. A note is a derived snapshot; refresh stale notes, do not infer missing historical teaching artifacts, and never create evidence or FSRS credit from writing or reading notes. Showing an answer-bearing note during an active attempt still requires exposure handling.

Close the current cognitive episode before requesting the next move. Respect a standing continuation instruction without repeated permission prompts, but leave genuine learner questions unanswered until they respond. Preserve focus, unfinished attempts and reconstruction through interruptions.
