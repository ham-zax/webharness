# Acquisition and retrieval playbook

Load this playbook when the current episode is about introducing language material, checking recognition, or performing due retrieval. Do not use it to choose the next objective or review date.

## New language material

Prefer the shortest useful path:

```text
meaningful context
-> learner inference when worthwhile
-> at most 1-2 useful hints
-> direct meaning/explanation when inference stops paying off
-> small use of the target when the current episode permits it
```

Rules:

- Context-before-definition is a strategy, not a law. If the learner asks directly for the meaning, answer directly.
- Translation is a legitimate scaffold. It is representation, never mastery identity or evidence by itself.
- Do not force inference on transparent cognates, trivial items, or a learner who is already blocked by the surrounding sentence.
- Prefer chunks, collocations, and usage context over isolated word glosses.
- For grammar or structure, use a compact contrast or example before a long explanation when that can expose the pattern efficiently.
- If the learner has not yet produced the target, a tiny production step can consolidate teaching, but it is not clean independent evidence merely because it happened after explanation.

## Adaptive entry for unknown or zero-start material

When the selected objective has preparation strategy `learn`, readiness is `unknown`, no diagnostic is pending, and `getPedagogyRecommendation(...)` returns guided work rather than an independent commit, treat the episode as **teach-first acquisition**, not as a cold production test. Do not ask for the full end-state task before the learner has been given the pieces needed to attempt it.

Use a small adaptive ladder rather than a fixed beginner worksheet:

```text
comprehensible item
-> meaning/contrast
-> tiny recognition or choice
-> guided micro-production
-> one changed use
-> later clean retrieval when Lingua selects it
```

- Start with the smallest answerable unit. One greeting, one noun, one number, one pronoun, one short chunk, or one contrast is enough.
- After clear success, increase only one useful dimension at a time: one more word, one changed fact, one extra slot, or one short question. Do not jump from a single known phrase to an integrated multi-fact task.
- If the learner is blocked, reduce the surface and teach the missing prerequisite immediately. Being unable to answer an untaught prompt is not a learner failure.
- Colors, numbers, concrete objects, names, pronouns, and common evaluative words are useful low-cost seed material, not mandatory gates or quotas. Prefer material that supports the next communicative objective.
- Translation may use three layers when helpful: **target-language form -> literal English mapping -> natural English meaning**. For a very early comprehension probe, the teacher may ask the learner for the literal mapping, the natural meaning, or both before asking for German production. This checks understanding cheaply; it is not German production evidence. The literal layer is a temporary structural scaffold, not a claim that word-for-word English is the grammar or the best translation. Omit it when it would mislead more than it clarifies.
- Speech-to-text, ordinary typing, and short written responses are all usable teaching channels when available. The adaptive ladder itself is modality-neutral. Only an assessed evidence opportunity must match its frozen response context; typed practice does not prove spoken delivery, and speech transcript does not prove spelling.

For a learner whose current experience is genuinely unknown rather than explicitly zero, a cold diagnostic may be appropriate. Start that diagnostic at the cheapest discriminating surface and stair-step upward only while the learner succeeds; once the boundary is found, switch to acquisition at the missing prerequisite instead of continuing to test above it.

## Retrieval

FSRS and Lingua OS decide when retrieval is due. The teacher chooses only the learner-facing form that matches the selected intent.

- Start cold when the selected intent is independent: no answer-bearing example, no leading hint, no model wording.
- Keep recognition, production, repair, and explanation distinct. Success in one does not imply the others. For an `explain` objective, prefer direct explanation/teach-back, correction of a flawed explanation, or compare-and-explain prompts; do not substitute MCQ recognition as the default evidence form.
- Prefer changed surfaces and natural contexts over replaying the exact wording that was just taught.
- When an objective is already strong on explicit rule knowledge but still open in a required production context, prefer realistic use over another "why?" question.
- If a due retrieval fails, do not immediately widen into a full lesson. Route the current episode into the repair playbook and repair the exact missing mechanism.

## Automaticity without a new score

Do not create an `automaticity` field or threshold. Use existing evidence and the selected communication context.

When deliberate evidence already shows the learner understands the mechanism but production in the active context remains open:

- use longer, more natural production;
- reduce metacognitive interruptions;
- correct selectively rather than stopping after every small error;
- preserve the active register and learner voice;
- route back to explicit repair only when the target mechanism materially breaks.