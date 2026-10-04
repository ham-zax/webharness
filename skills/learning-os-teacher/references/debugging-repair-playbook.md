# Debugging and repair playbook

Use this reference only when the current Learning OS-selected episode is debugging-oriented, a prediction has failed, or assessed work exposes a causal/model error that needs repair. Do not use it to schedule a new weakness retest or transfer task.

## Contents

- Invocation rule
- Fast routing
- Hypothesis set and fastest falsifier
- Earliest consequential failure
- Self-localization before correction
- Slip versus model error
- Mental-model autopsy
- Precision remediation
- Cognitive-vaccine retest authoring
- Reconstruction
- Stop rules

## Invocation rule

Prefer diagnosis over explanation until the responsible failure boundary is clear enough to act on. Use the smallest repair that changes the faulty model. Do not make every bug a postmortem.

## Fast routing

| Situation | Prefer |
| --- | --- |
| Debugging is guess-driven | 2–3 hypotheses + cheapest discriminating test |
| Several downstream symptoms exist | localize earliest consequential failure |
| Learner can inspect decisive evidence safely | self-localization before teacher correction |
| Learner repeatedly repeats one wrong assumption | cognitive-vaccine retest only when Learning OS later selects the retest |
| Error is a typo/slip | brief correction/recast |
| Error follows a coherent wrong model | mental-model autopsy + reconstruction |
| Weakness retest is already selected by Learning OS | precise changed-surface discriminator |
| Learner is stuck but cause is unclear | one blocker-disambiguation question first |

## Hypothesis set and fastest falsifier

When the learner is anchoring on one explanation, ask for a small competing set instead of more guesses.

```text
hypothesis A -> predicts observation A
hypothesis B -> predicts observation B
hypothesis C -> predicts observation C
-> which cheapest observation separates them?
```

A useful question is: **What experiment would disprove your current explanation fastest?**

Keep the set small. Two hypotheses are often enough. The goal is discriminating evidence, not brainstorming volume.

## Earliest consequential failure

When one upstream error creates many downstream failures, repair the first consequential divergence rather than cataloging every symptom.

```text
expected path
-> first observed divergence
-> responsible boundary
-> downstream consequences
```

Use existing frozen criteria and `observedErrors`; do not create a new failure taxonomy merely to label the chain.

## Self-localization before correction

After the learner has committed and decisive evidence can safely be shown:

```text
show the relevant output/log/reference
-> ask where their prediction first diverges
-> let learner identify the mismatch
-> correct only what remains unresolved
```

This trains self-debugging and calibration. If showing the evidence is answer-bearing during an active attempt, record the appropriate exposure first.

## Slip versus model error

Do not autopsy trivial mistakes.

**Slip:** typo, transient omission, syntax accident, misread value, or wording mistake inconsistent with the learner's otherwise-correct model.

Response: brief correction/recast, then continue or close.

**Model error:** the learner consistently predicts or explains the wrong result from a coherent faulty relationship or assumption.

Response: repair the model, not just the answer.

## Mental-model autopsy

Use after assessment when a coherent causal error is established.

```text
expected result
-> learner's faulty assumption
-> observation that contradicts it
-> corrected relationship/invariant
-> learner reconstructs the model
```

Ask only for the parts necessary to repair the selected objective. Avoid turning one error into a broad theory lecture.

## Precision remediation

When Learning OS has already selected a weakness, minimize incidental concepts until the faulty relationship is discriminated.

A remediation challenge should make the wrong and corrected models produce different outcomes. Do not quietly add unrelated complexity to make the task feel harder.

After the relationship is repaired, later widening/transfer remains a Learning OS selection decision.

## Cognitive-vaccine retest authoring

Use only when Learning OS later selects a weakness retest/changed-surface challenge. Do not schedule this yourself.

Author a fresh surface where:

```text
old faulty assumption -> predicts A
correct repaired model -> predicts B
```

The new challenge should target the same misconception without copying the original wording or revealing the mapping. This is a challenge-authoring technique, not a scheduler or durable learner state.

## Reconstruction

Require reconstruction when answer-bearing teaching repaired a causal/foundational model.

Good reconstruction asks the learner to rebuild the relationship, explanation, trace, or solution in their own structure. It should not be a yes/no acknowledgment.

Do not require reconstruction for ordinary slips, minor terminology refinement, or harmless rephrasing.

## Stop rules

Stop when:

- the responsible failure boundary is localized;
- the minimal repair resolves the faulty model;
- the learner reconstructs successfully or explicitly opts out through the normal lifecycle;
- further probing would add unrelated failure criteria;
- interview/mock assessment is still open and answer-bearing coaching must wait for debrief.
