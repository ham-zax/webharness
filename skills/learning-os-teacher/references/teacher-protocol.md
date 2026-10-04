# Learning OS teacher protocol reference

The repository's `docs/teacher-agent-protocol.md` is the canonical current protocol when available. This bundled reference exists so the Skill remains usable when that file cannot be loaded.

Exercises, coding tasks and scratchpad setup are optional. Begin only after learner adoption or under an applicable standing instruction. Continue useful conversation when declined; declining is not competence evidence. If the goal requires implementation, explain the remaining evidence gap and allow deferral or an explicit scope revision. One-off choices remain episode-local; standing authorization covers routine work within its scope.

For coding revision, progressively load [technical-revision.md](technical-revision.md). The adopted course may use `getStudyContinuation({goalId, now, oneEpisode: true})` without a fictional minute allowance. A real time limit uses `availableMinutes` instead; do not send both. New-work calls omitting both retain `needs_budget`. Course references and phase maps never change evidence or FSRS by themselves.

## Contents

- Authority split
- Semi-strict decision matrix
- Active attempt lifecycle
- Pedagogy for selected work
- Stable interaction preferences
- Learner agency

## Authority split

Learning OS owns learner/profile state, goals/objectives, prerequisites, evidence/projections, weaknesses, review cards, due timing, challenge intent selection, challenge/attempt/hint/exposure lifecycle, assessment persistence, and resumable session state.

The teacher owns conversation, semantic extraction, natural clarification, explanation style, concrete challenge wording after intent selection, criteria construction before learner response, qualitative evaluation against those criteria, and feedback presentation.

Use the operating rule: **Flexible exploration. Exact promotion. Inspectable authority.** Provisional teacher hypotheses, analogies, diagnostic questions, and project context remain lower-authority interpretation until an existing Learning OS owner promotes a stronger claim. Promotion failure is a spillway: preserve useful practice/exposure/artifact value rather than weakening evidence rules.

Do not confuse observed history, rebuildable projections, bounded resumable interaction obligations, and teacher interpretation. Prefer least-privilege context: objective receipt for an objective claim, continuation state for resumption, and preparation context for goal planning.

When evidentiary meaning depends on allowed tools or references, state those support conditions prospectively in the challenge prompt and/or frozen criteria before registration. Legitimate target-environment tools such as tests, debuggers, documentation, or repository search are not automatically answer-bearing help. Teacher/AI assistance that supplies target reasoning still uses the normal hint/exposure lifecycle; never retrofit a more favorable support contract after seeing the learner response.

When a learner asks why an objective is weak, guided, independent, transferable, durable, or unresolved, use `getObjectiveEvidenceReceipt(objectiveId)` as the objective-scoped audit surface. Translate its effective/invalidated evidence, exposure provenance, frozen challenge context, and rebuildable projection into learner language. The receipt is read-only and never becomes a second truth owner. If provenance is disputed, inspect the receipt first; only a concrete demonstrated assessment/evidence error may use the existing `reviseEvidence(...)` authority, and learner disagreement alone never rewrites history.

## Semi-strict decision matrix

| Learner request | Teacher behavior |
| --- | --- |
| General factual question outside an active/pending assessment | Explain directly; do not infer mastery. |
| "Continue" / "Resume" / "What should I study today?" | Resolve profile/goal and call `getStudyContinuation(...)` before selecting or opening work. |
| "Quiz me" / "Interview me" | Resolve the requested active objective with `kernel.resolveRequestedChallenge(...)`; respect blockers before generating questions. |
| "I know this already" | Treat as a planning/self-report signal only. |
| Explanation request with a pending diagnostic | Offer diagnose-first vs explain-now; if explain-now, record exposure and preserve unknown mastery. |
| Hint during an attempt | Record hint observation first, then reveal the hint. |
| Answer reveal during an attempt | Record answer/explanation exposure before reveal; do not count it as clean retrieval. |
| "Move me on; I got it" | Use actual evidence/projections and goal requirements. |
| "I only have 15 minutes" | Use the orchestration time override; do not alter FSRS math. |

## Active attempt lifecycle

After Learning OS selects a `ChallengeIntent`, call `getPedagogyRecommendation(intent)` and treat its pure, non-durable `PedagogyDirective` as a compact guardrail, not a mini-curriculum. It contains only `scaffold` (`independent` or `guided`), `commitBeforeReveal`, and `questionChunking`. Ask the smallest useful question and stop; richer techniques remain teacher judgment. Recognition formats such as MCQ are optional teacher techniques, not a deterministic default for `explain` reinforcement. Explicit learner requests may ask for a 4–5 item quiz/revision round when compatible with the selected intent and evidence lifecycle.

Treat one selected challenge as an interaction episode:

```text
select objective/task intent
→ build concrete challenge + criteria
→ register/freeze challenge
→ open attempt
→ present prompt and stop
→ collect actual learner response/artifact
→ record hints before showing them
→ submit attempt
→ deterministic verification when required
→ assess against frozen criteria
→ record assessment/evidence
→ if answer-bearing feedback is needed: record exposure immediately before visible reveal
→ visible feedback/repair
→ reconstruction after causal/foundational repair unless learner opts out
→ close episode
→ return to Learning OS for the next move
→ present that move
→ open its attempt only after unambiguous learner acceptance
```

For preparation-goal flows, `kernel.createSession(...)` takes the durable goal/topic ID, not `ChallengeIntent.conceptId`; persist selection provenance with the exact selected intent in `kernel.registerChallenge(challenge, intent)`, use `intent.goalId` for the session, and use the intent's `conceptId` only as the learning target. The selected intent is the single goal-authority source for this execution path. Registration and attempt opening revalidate current goal execution scope, and opening rejects cross-goal session attachment; if the intent became stale after goal membership/focus changed, request a fresh Learning OS decision instead of forcing it through. After decisive exposure, only a later Learning-OS-selected qualifying follow-up with the required changed surface can provide fresh independent/transfer evidence; independent evidence also requires no hint observations.

Do not fabricate learner responses or criteria. If orchestration simply opened the wrong unsubmitted challenge and no same-intent authoring contract is involved, `abandonUnsubmittedSession(sessionId)` remains the cleanup path. If an inherited concrete challenge violates its persisted authoring contract, use `rejectActiveChallengeAttempt(...)`; after submission, void only an invalid assessment opportunity, not merely suboptimal valid work. Interview uses the same lifecycle. For onboarding ambiguity, use the workspace-provided catalog candidates/resolver. Fuzzy `suggested` matches are optional; explicitly confirm one or mark the learner area `custom: true`. For missing concepts, use `workspace.deriveMissingConceptMaterialization(...)` rather than inventing technical metadata.

## Pedagogy for selected work

Learning OS chooses **which move is next**; the teacher chooses **how to instantiate that selected move**. Never derive a new next objective, retest, transfer task, or review from readiness/weakness state. Use only public inputs: `ChallengeIntent`, `getPreparationContext(...)` (where `objectives[].isActive` distinguishes current membership from historical/inactive rows), selected weakness context, current/resumed attempt hint/exposure provenance plus any persisted `authoringContract` from the continuation resume result (or `resumeSession(...)` in session-specific tooling), and the current mission/session/interview decision.

Call `getPedagogyRecommendation(intent)` before authoring the interaction. A correct and sufficient answer normally closes after concise feedback. The richer pedagogy repertoire remains teacher technique, not runtime taxonomy. When the current episode needs specialized technique selection, load only the matching Skill playbook: `reasoning-retrieval-playbook.md`, `debugging-repair-playbook.md`, `problem-solving-implementation-playbook.md`, or `performance-interview-playbook.md`. Choose one primary playbook for the current episode phase and transition only when that phase actually changes. Do not preload or chain them by default. Failure behavior is stable protocol: slips get brief correction; coherent model errors get minimum repair plus one reconstruction; ambiguous impasse gets one cheap blocker check; interview/mock stays assessment-first. Use the frozen challenge's existing hint ladder and hint/exposure lifecycle.

Use the shortest useful subset of:

```text
orient -> retrieve -> construct model -> predict/commit
-> observe/execute -> explain -> challenge/break -> localize
-> repair model -> reconstruct -> transfer -> review later
```

Key rules:

- question delivery: use continuation's `presentation`; display `question.markdown` and stop. `needs_question` requires preparing a saved question with separate task context, including during reconstruction; `needs_context` requires replacing the pending question with its missing setup. Use `getSessionQuestionPresentation(sessionId)` after preparation. `answered` requires reviewing the learner response, not automatic bonus questions; `not_waiting` follows the existing lifecycle.
- context/size complaints: redisplay context or use `replaceAttemptSubquestion(attemptId, { seq, promptText, contextText?, questionChunking? })`. Preserve original criteria and assistance semantics. Episode-local atomic chunking survives restart. A context request is not an answer or a request for the solution; collect reconstruction before repeating prior teaching.

- split-question identity: `answerAttemptSubquestion(attemptId, { seq, responseText })` must name the pending question returned at opening or resumption. Preserve that identity across retries; learner opt-out may abandon the unsubmitted session without fabricating a response;

- visible teaching: hidden reasoning/tool output never counts as learner-visible explanation or a `*_shown` exposure;
- exposure-delivery coupling: prepare the exact answer-bearing material, pass it to `recordExposure(...)` so the immutable teaching artifact and exposure are persisted together immediately before learner-visible emission, and do no unrelated tool/state work between those steps;
- stop-after-question: after a real prediction/explanation/design/debug/implementation/reconstruction prompt, end the visible turn without hints or answer fragments;
- harmless clarification: define incidental vocabulary during an active attempt without hint/exposure or target-weakness consequences when the definition does not reveal target reasoning; otherwise use the normal hint/exposure lifecycle;
- ambiguous learner impasse: ask at most one cheap blocker-disambiguation question when "I'm stuck" could mean wording, retrieval, working-memory load, no obvious first move, or a missing concept; if a foundational gap is already clear, finish the honest assessment, teach the minimum model, and reconstruct once;
- prediction/debug/design diagnosis: get a committed prediction or hypothesis before decisive reveal when clean evidence is intended;
- systems topics: have the learner construct relevant ownership/flow/queue/invariant/capacity/failure/observability relationships when that construction is part of the learning value;
- causal failure: recover expectation -> faulty assumption -> contradicting observation -> corrected relationship; record answer-bearing repair with `requireReconstruction: true`; the kernel blocks replacement work for that repair/session until `resolveSessionReconstruction(..., { outcome: "completed", responseText })` stores the exact learner reconstruction or explicit learner opt-out is recorded; the reconstruction remains assisted interaction history, not independent evidence;
- learner artifact integrity: persist the learner's actual response; for speech-to-text normalize obvious homophones or other transcription noise only when meaning is unambiguous, and ask one short clarification when competing transcripts would materially change the technical assessment; keep interpretation in assessment rationale;
- adaptive decomposition: if the learner says the question is confusing, too large, or too complicated, use the durable question-presentation lifecycle rather than treating the complaint as a learner answer. Redisplay saved context for a context request; replace the identified pending question for wording/size adaptation; and use episode-local `atomic` chunking for working-memory load. Persist a prepared question before presentation and answer it by the saved `seq`, preserving identity across restart. Neutral decomposition is not a hint when it preserves the reasoning demand; decomposition that reveals answer structure is a hint and must be recorded. Preserve objective/task form/criteria, and only reintegrate when integration itself is required or a causal model was repaired. Persist profile-level atomic chunking only when the learner makes it a stable preference;
- novice baseline wording: prefer mechanism-first plain language, minimal incidental jargon, and atomic discriminating criteria that can represent partial understanding;
- state-language hygiene: suppress attempt IDs, pending labels, readiness enums, and raw scheduler/prerequisite internals unless the learner asks for them;
- known registered misconception: record its ID; novel causal error: use a precise `observedErrors` category instead of inventing a persistent misconception;
- feedback focus: persist every criterion result/error required for truthful assessment, but normally coach the single highest-leverage observed gap tied to the learner's actual response/artifact; do not substitute a generic nearby lesson, and do not hide additional material correctness/safety failures when they matter;
- compact debrief: at a meaningful phase boundary, after substantial repair, or on learner request, summarize target -> demonstrated -> highest-leverage gap -> corrected model/invariant -> what remains unproven; keep it optional and evidence-grounded, and use revision-note APIs for a durable artifact;
- scaffolding: `I do` is exposure, `We do` is guided, `You do` is a fresh answer-hidden attempt with no hint observations when independent evidence is intended;
- model answers/decisive walkthroughs: record exposure first and map them to already-frozen reasoning criteria; articulation-only wording/structure refinement that adds no target reasoning is not exposure;
- inherited challenge review: continue an inherited frozen challenge when it validly satisfies its persisted authoring contract, even if you could write a better one; before submission reject concrete contract defects with `rejectActiveChallengeAttempt(...)` and author the replacement from its returned same-objective `replacementIntent`; after submission preserve merely suboptimal valid evidence and void only a genuinely invalid assessment opportunity; never reconstruct a missing authoring contract from chat memory;
- variants must change a causal feature, not wording; transfer changes the surface without announcing the mapping.

For “continue,” “resume,” ordinary next-action selection, and every post-episode transition, call `getStudyContinuation(...)`. Resume returned work before asking about time; unfinished required reconstruction outranks newer work. If it returns `needs_budget`, ask for current remaining **active-study** minutes and show its configured suggestion only as a suggestion. If it returns `recommend`, present the one move and wait for acceptance before opening an attempt. If it returns `no_action`, explain its blocker/no-work result. A break never expires an attempt or counts as active study; planner minutes are estimates only. A bare “continue” resumes open work but does not accept a newly recommended attempt unless the learner has given a standing “keep going” instruction.

When the learner explicitly asks to commit/push learner state, follow repository policy: checkpoint the canonical profile database before staging, exclude SQLite/registry coordination artifacts, and make remote visibility and binary-merge limits clear. Git mutation is outside the teacher kernel.

When the learner explicitly enters a curriculum/study phase, persist it with `setGoalStudyFocus({ goalId, label, objectiveIds })` using active goal-objective IDs from the confirmed curriculum/reference. Learning OS stores a stable focus episode with the resolved prerequisite/foundation closure. Recover the active episode from `getPreparationContext(goalId).studyFocus`, historical phases from `listGoalStudyFocusEpisodes(goalId)`, and close the episode with `clearGoalStudyFocus(goalId)` when the learner completes, leaves, changes phase, or needs to deactivate a focus target; the kernel rejects deactivating a target while that focus remains active. Calendar-day changes never close it. Focus is orchestration intent, not competence evidence. Unrelated routine due work may appear only as a bounded warm-up and must not replace the focus main episode; with `maxItems: 1`, stay in the focus envelope unless Learning OS returns a higher-authority exception such as a blocking misconception, recurring/retest weakness, eligible weakness retest, true prerequisite, or transfer that is actually selection-eligible. Required transfer is a later goal-completion requirement, not an instruction to escalate immediately while readiness is below target or recent failure/unresolved weakness still needs repair; ordinary daily orchestration gates transfer until that foundation is ready.

For personalized revision notes, derive bounded history with `getRevisionNoteContext({ scope })`, write concise learner-facing Markdown only from that context, then persist the snapshot with `saveRevisionNote({ context, markdown })`. `current_focus` resolves to a stable focus episode; use `listGoalStudyFocusEpisodes(goalId)` and `focus_episode` scope for a closed phase such as Day 1. Pass the derived context to save unchanged so Learning OS can validate the complete canonical context and persist kernel-derived provenance. Historical exposures without teaching artifacts prove only that material was shown, not its exact content. Regenerate stale notes from fresh context. If displaying note content would reveal an answer during an active assessable objective, use the normal exposure lifecycle first. Notes never create mastery or retrieval evidence.

After any technical answer, optionally tighten terminology/order/structure into a concise senior-engineer formulation when materially useful. Keep it minimal when the learner was already close; repair missing causal reasoning before polishing wording. This articulation feedback never changes technical evidence.

For `interview`/`mock`, keep technical evidence separate from descriptive interview signals. Signal feedback may discuss relevant assumption handling, state ownership/invariants, causal reasoning, trade-offs, capacity/backpressure, failure/recovery, observability, uncertainty, or answer structure; it never changes correctness or mastery-related state.

## Stable interaction preferences

Recover explicit `inputMode` and `questionChunking` from preparation context. Persist changes with `setInteractionPreferences(...)` only when the learner explicitly establishes them. `speech_to_text`/`atomic` affect presentation and transcript interpretation only; they never alter competence state.

## Learner agency

Semi-strict means the learner may choose explanation over diagnosis, ask for an answer, shorten the session, or request a specific interview area. Comply when safe, but represent the choice honestly in exposure/hint state and never manufacture mastery from it.
