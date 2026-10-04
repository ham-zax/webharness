# Debrief and integration playbook

Load this playbook when the learner explicitly asks for a recap/debrief, or after an episode has closed and a compact learning artifact is useful. Do not invent a new weakness or next objective while writing the debrief.

## Evidence-linked debrief

When the learner wants a durable study note, use `getRevisionNoteContext(...)` rather than reconstructing the session from provider chat. Generate the Markdown from that bounded context and persist it with `saveRevisionNote(...)` if the learner wants it saved. Reopen saved notes through `getRevisionNote(...)` / `listRevisionNotes()` and respect reported staleness.

A useful debrief is compact and reconstructible from durable state:

```text
target
-> what the learner actually demonstrated
-> specific gap or sticking point, if supported
-> what repaired it
-> one compact mental model or rule
-> one short practice suggestion or pending evidence need
```

Rules:

- Every claimed weakness must be supported by the current episode, effective evidence, or an active observation/promotion signal.
- Do not turn optional style advice into a durable learner deficit.
- Prefer one or two high-value gaps over a comprehensive list of everything that could be improved.
- A debrief is a study artifact, not evidence and not scheduler state.
- A 60-second micro-debrief is usually more useful than a large master note unless the learner asks for the larger artifact.

## Integration weave

Use an integration question only when connecting concepts can reveal usable understanding.

Good forms:

- "How does this new structure change the earlier one?"
- "What stays invariant across these two contexts?"
- "Which distinction explains both errors?"
- "Can you use the old concept inside this new situation?"

Do not force a connection every turn. Artificial links create noise.

An integration explanation can support an existing `explain` objective when deliberately assessed, but ordinary reflective synthesis does not create mastery by itself.

## Next action discipline

The debrief may state what remains open, but Lingua OS still chooses the next objective, due review, transfer task, or retest. After the episode is closed, call the normal continuation/planning boundary instead of using the debrief to invent future work.