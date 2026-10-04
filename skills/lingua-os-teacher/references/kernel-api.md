# Lingua OS public teacher API map

Use repository-local `docs/lingua-teacher-agent-protocol.md` as normative authority. This reference is a compact routing map for a fresh agent.

## Before profile binding

Use `createTeacherWorkspace(...)`:

- `listProfiles`, `getProfile`, `getActiveProfile` — resolve local learner identity.
- `loadKnowledgeCatalog` / `resolveCatalogArea` — inspect language-scoped curriculum.
- `planOnboardingInformationNeeds` — ask only missing onboarding questions.
- `buildOnboardingProposal` — produce deterministic sparse goal/objective proposal.
- `deriveMissingConceptMaterialization` — create validated language-scoped metadata when confirmed curriculum coverage is missing.
- `applyConfirmedOnboarding` — create the first profile or add a language goal only after explicit confirmation.
- `openProfile` — open one profile and bind a `TeacherKernel`.

## Profile-bound durable state

Use `TeacherKernel`:

### Goals and continuation

- `listPreparationContexts()` / `getPreparationContext(goalId)` — durable multilingual goals/objectives.
- `getStudyContinuation(...)` — resume unfinished work or return one next action.
- `getTodayMission(...)` / `resolveRequestedChallenge(...)` — bounded planning and explicit objective requests.
- `getGoalRequiredCommunicationContext(goalId)` — exact goal language/modality/register triple.
- `getInteractionPreferences()` / `setInteractionPreferences(...)` — stable speech-to-text and question-chunking preferences.

### Natural communication

- `resolveResponseModality(...)` — determine modality and capture-time ASR risk.
- `recordCommunicationSample(...)` — retain a bounded literal artifact only when provenance is useful.
- `recordLanguageObservation(...)` — direct writer only when frozen sample ASR risk is false.
- `recordAsrGatedLanguageObservation(...)` — mandatory writer for retained ASR-risk samples.
- `reviseLanguageObservation(...)` — append-only invalidate/restore.
- `listEffectiveLanguageObservations(...)` — effective observation state.
- `listObservationPromotionDecisions(...)` — observation policy without mastery mutation.
- `listActiveGoalObservationPromotions(goalId)` — actionable diagnostic/practice pressure.

### Deliberate challenges and teaching

- `registerChallenge(challenge, intent)` — freeze a new V2 Lingua challenge matching selected intent/context.
- `createSession(...)`, `openAttempt(...)`, `submitAttempt(...)` — deliberate attempt lifecycle.
- `recordHintUse(...)` / `recordExposure(...)` — learner-visible help provenance.
- `recordMaterialLanguageCorrection(...)` — corrective exposure plus required reconstruction for material language repair.
- `resolveSessionReconstruction(...)` — complete or explicitly opt out of required reconstruction.
- `recordAssessment(...)` — create authoritative EvidenceEvents from a submitted frozen attempt.
- `getPedagogyRecommendation(...)` — execution guardrails for an already-selected intent.

### Evidence and scheduler inspection

- `getObjectiveProjection(objectiveId)` — broad deliberate readiness/transfer/durability state.
- `listWeaknessProjections(objectiveId)` — assessed weakness state; natural observations never write this projection directly.
- `getObjectiveContextProjection(objectiveId, context)` — rebuild exact-context state from effective frozen evidence.
- `getEvidenceEvent(...)` / `listEffectiveEvidenceEvents(objectiveId)` — authoritative deliberate evidence.
- `listEffectiveReviewEvents(objectiveId)` — effective ReviewRatingMapper outputs.
- `getObjectiveReviewCard(objectiveId)` — current FSRS review-card state.

### Revision notes and debriefs

- `getRevisionNoteContext(...)` — derive a bounded, provider-neutral context over relevant attempts, learner responses, effective evidence, weaknesses/projections, hints, exposures, teaching artifacts, and curriculum references.
- `saveRevisionNote(...)` — persist learner-facing Markdown only after the kernel re-derives and validates the same canonical context.
- `getRevisionNote(...)` / `listRevisionNotes()` — reopen saved notes and inspect staleness against authoritative source high-water state.

Revision notes are study artifacts, not evidence. If showing answer-bearing note content during an active assessable interaction would teach the answer, record normal exposure before display.

### Vocabulary

- `materializeVocabularyTarget(...)` — create or reuse one language-owned lexical target, persist its lexical/sense/translation representation, create missing `recognize`/`produce`/`repair` objectives, and activate the requested objectives for the supplied goal.
- `getVocabularyTarget(...)` — recover one durable lexical representation by concept ID.
- `listGoalVocabularyTargets(...)` — recover durable lexical representations plus the active objective memberships for one goal.
- `setGoalObjective(...)` — adjust goal membership metadata explicitly when the default vocabulary activation is not sufficient.

Vocabulary concepts remain reusable across goals. Translation hints remain representation metadata and do not create objective identity or competence.

## Do not bypass these boundaries

Do not directly write readiness, weakness projections, review cards, or FSRS state. Do not manufacture objective IDs inside conversation logic. Do not source EvidenceEvent communication context from mutable goal/profile/session state. Do not use current input preference to reinterpret a retained sample's frozen `asrRisk`.