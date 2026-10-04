# Lingua observation-to-retrieval episode protocol

Use this sequence when natural learner communication reveals a potentially useful language pattern.

## 1. Observe without manufacturing mastery

1. Keep the conversation natural.
2. Resolve modality and capture-time ASR risk.
3. Retain the literal learner sample only when observation provenance is useful.
4. For ASR-risk samples, run the atomic ASR-gated observation writer.
5. Map to a real materialized target/capability only when justified.
6. Record stable error category, impact/significance, exact context, rationale, and evaluator provenance.
7. Never call `recordAssessment` for this natural sample.

Expected policy:

- isolated low-impact learner-likely event -> observe more;
- ambiguous or transcription-likely -> no learner weakness work;
- obvious homophone/transcription noise -> normalize only when intended meaning is unambiguous and the normalization cannot change the assessment;
- multiple plausible transcripts that could change semantic, language, or technical correctness -> ask one short clarification before assessment; do not guess or penalize;
- not-observable -> source modality cannot prove the contrast;
- repeated learner-likely occurrences across distinct matching samples -> possible diagnostic pressure;
- invalidated observations no longer contribute.

## 2. Promote into deliberate work

Call promotion for the active goal.

A selectable diagnostic/practice signal must point to an existing language-scoped objective. If the target is known but not materialized, use curriculum/onboarding/vocabulary materialization first.

Planning remains authoritative. Promotion creates pressure, not a new scheduler or mastery state.

If a goal has required context, eligibility is checked against exact matching deliberate evidence before ordinary relevance filtering. Do not substitute a different language/modality/register because it is convenient.

## 3. Diagnose the missing capability

Author the selected V2 challenge with the exact intent context and changed-surface requirement.

For a production pattern, distinguish where practical:

- can the learner recognize the correct form/rule?
- can the learner produce it without help?
- can the learner detect and repair the error?

Use actual `recognize`, `produce`, and `repair` objectives when they exist. Do not infer that rule knowledge is absent solely from a production error.

Collect learner output before answer-bearing model wording.

## 4. Teach minimally and record exposure before reveal

After an assessed failure, teach only the missing mechanism.

If the correction gives away the target answer/mechanism:

1. prepare the exact learner-visible correction;
2. call `recordMaterialLanguageCorrection(...)` immediately before showing it;
3. reveal the recorded material;
4. require learner reconstruction;
5. resolve reconstruction through the kernel before closing the feedback episode.

Do not require reconstruction for trivial stylistic alternatives or wording polish that does not supply a missing mechanism.

Immediate corrected repetition is guided/exposed and is not clean independent retrieval.

## 5. Re-test later on a changed frozen surface

After the teaching episode closes, request/accept a later deliberate task.

The new challenge must:

- preserve the selected objective;
- preserve/freeze the intended communication context;
- be materially changed when the intent requires changed surface;
- hide answer-bearing model wording until after learner response;
- use frozen criteria capable of assessing the intended capability.

Submit the learner's actual response and assess it normally.

Only then may the kernel create:

```text
EvidenceEvent
-> objective projection
-> ReviewRatingMapper output
-> FSRS review card
```

## 6. Fresh-teacher continuation

A replacement teacher should reopen the same profile and recover:

- durable language goals and contexts;
- interaction preference;
- effective observations and promotion pressure;
- open session/reconstruction state;
- frozen challenges/authoring contracts;
- deliberate evidence and objective projections;
- effective review events and FSRS card.

Do not reconstruct any of these from old provider chat history.

## 7. Multilingual and vocabulary boundaries

Keep each goal/context independent. English performance evidence must not close German acquisition objectives.

For vocabulary, recognition, production, and repair are separate objectives. Translation is a cue/teaching representation only; do not use translated text as durable identity or as proof that the target-language lexeme is mastered.