---
name: lateral-thinking
description: "Route creative problems through one of eight structured lateral-thinking methods: random stimulus, provocation, assumption inversion, concept fan, forced analogy, SCAMPER, six hats, or worst possible idea. Use when a user asks for lateral thinking, fresh or non-obvious ideas, a different angle, help escaping predictable brainstorming, challenging a fixed constraint or assumption, widening a stuck solution space, generating variations of an existing idea, or examining a creative decision from multiple perspectives. Apply to product, strategy, naming, copy, workflow, service, and design ideation. Do not use to perform debugging, code review, calculations, factual research, or implementation; redesigning those processes creatively is in scope."
---

# Lateral Thinking

## Purpose

Diagnose the shape of a creative block, choose exactly one technique, and run that technique visibly. Preserve failed branches and abandoned attempts instead of making every move look successful.

## Core contract

- Treat the user's concrete creative target as the input.
- Return a structured ideation session as the output: the technique steps, promising directions, visible dead ends, a meta-pattern, and optional next moves.
- Use no connector by default. Use external tools only when the user's target independently requires current facts or connected data.
- Ask at most one focused clarification if the target or symptom is materially unclear.
- Run exactly one technique per pass. Offer another technique only after finishing the first.
- Do not push the user to commit. Diverge first; leave convergence to the user unless the chosen technique explicitly includes synthesis.
- Refuse requests to perform analytical work such as debugging, code review, calculations, or implementation. Creative redesign of an analytical process remains valid.

## Route the symptom

| Symptom | Technique | Reference |
|---|---|---|
| Ideas all feel similar or predictable | Random Stimulus | `references/random-stimulus.md` |
| A rule or constraint feels unbreakable | Provocation | `references/provocation.md` |
| Requirements hide unquestioned beliefs | Assumption Inversion | `references/inversion.md` |
| The current solution may answer the wrong problem | Concept Fan | `references/concept-fan.md` |
| The solution works but feels derivative | Forced Analogy | `references/analogy.md` |
| One existing idea needs disciplined variations | SCAMPER | `references/scamper.md` |
| A decision is moving too fast or from one angle | Six Hats | `references/six-hats.md` |
| Everything feels timid, safe, or over-optimized | Worst Possible Idea | `references/worst-idea.md` |

## Routing procedure

1. Diagnose the user's symptom from the table.
2. If two techniques seem plausible, pick the one matching the user's immediate blockage rather than combining methods.
3. If the symptom is unclear, ask exactly one concrete question. Prefer questions such as "What feels stuck: the problem framing, a fixed constraint, or the sameness of the ideas?"
4. Read the selected reference file and follow it inline.
5. Preserve the technique's honesty mechanics. Show empty operations, dead flips, failed mappings, disqualified ideas, or abandoned stimuli where required.
6. End with the technique's meta-pattern. Explain what the successes and failures collectively reveal.
7. Offer a small set of next moves: deepen one direction, repeat the same method with fresh material, switch technique, or stop.

## Shared quality rules

### Make failure visible

Do not retrofit every prompt into a winner. A credible session contains misses. Keep them visible and state why they failed the technique's own test.

### Keep the chain inspectable

Show enough intermediate work for the user to see how a direction emerged. Do not jump from a technique prompt directly to a polished idea if the reference requires a property list, mapping, movement step, assumption flip, or badness mechanism.

### Prefer structural novelty

Reject cosmetic renaming as novelty. Favor changes in roles, flows, sequence, incentives, constraints, timing, ownership, or system behavior.

### Name the meta-pattern

After the batch, compare both winners and failures. State the structural insight that explains what kept working, what kept dying, or what hidden assumption controls the space.

### Bound the batch

Respect each technique's maximum batch size. Depth and honesty matter more than filling every slot.

## Technique-specific references

- `references/random-stimulus.md` - force-fit unrelated stimuli, with a stimulus pool.
- `references/provocation.md` - generate deliberately absurd Po statements and extract movement.
- `references/inversion.md` - flip assumptions into plausible opposites and hunt for where they are already true.
- `references/concept-fan.md` - climb abstraction, fan alternative concepts, and drop back to concrete implementations.
- `references/analogy.md` - map the target to distant structurally similar systems and transplant mechanisms.
- `references/scamper.md` - transform one existing idea through seven lenses and retain only operations that bite.
- `references/six-hats.md` - examine one decision through six unblended passes.
- `references/worst-idea.md` - generate plausible terrible solutions, isolate why they are bad, and invert the mechanisms.
- `references/SOURCE.md` - source attribution and adaptation notes.

## Source and license

This skill adapts the MIT-licensed `danium/lateral-thinking` repository. Preserve `LICENSE.txt` and `references/SOURCE.md` when redistributing substantial portions of this skill.
