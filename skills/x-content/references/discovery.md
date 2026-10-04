# X Discovery and Opportunity Selection

Use this reference when content selection depends on fresh Growth OS discovery state, authenticated X For You observations, creator-watch timelines, or multi-source provenance.

`x-content` interprets the opportunity. Growth OS owns discovery state, ranking inputs, dispositions, routes, relationship state, approvals, and persistence. `agent-browser` owns live X observation mechanics.

## Source semantics

Treat `sourceKinds` as provenance: where the canonical candidate was observed.

### `x_for_you`

The post was observed in the authenticated account's personalized X **For You** feed.

This is valuable because it can surface fresh, personalized conversation/topic signal earlier than keyword search.

It does **not** prove:

- virality;
- truth;
- relevance to the account;
- relationship strength;
- that Hamza should react;
- that X will distribute Hamza's response.

Do not say or imply "X is pushing this" unless the evidence supports something more specific than one observed recommendation.

### `x_creator_latest`

The post came from the latest-original-post creator lane. The lane may contain:

- relationship-selected creators; and/or
- explicitly configured signal-watch creators.

A watch-only creator does not gain fake relationship history. Do not write as if an existing relationship exists unless Growth OS or live context shows one.

### `x_momentum`

The candidate has observed momentum context from the existing momentum source. Use actual observed metrics/age when they materially affect the content decision.

Do not turn one velocity snapshot into a universal claim that the post is "going viral" unless the governing measurement definition supports that wording.

### `x_latest`

The candidate was found through fresh X search/topic discovery. Freshness is useful, but freshness alone is not a reason to publish.

### `github_trending` / `hn_top`

These are non-X discovery sources. Inspect the primary repository/article and supporting evidence before making technical claims.

## Multi-source candidates

The same X status may appear through several sources, for example:

`x_for_you + x_momentum + x_creator_latest`

Keep it as one canonical content opportunity.

Multiple source kinds can increase confidence that the post is worth **inspecting**, because several independent discovery paths surfaced it. Do not translate source count into an automatic quality score, voice treatment, or publication decision.

Ask what each source adds:

- `x_for_you` -> personalized recommendation context;
- `x_momentum` -> measured velocity/context;
- `x_creator_latest` -> early creator-watch timing;
- `x_latest` -> topical/search freshness.

Then judge the contribution itself.

## Canonical Discover identities

When working with the current Growth OS UI/API, distinguish:

- `to-review` — aggregate unresolved candidate inbox;
- `x-for-you` — the real authenticated X For You source;
- `creators` — creator-watch/latest source;
- `x` — X latest search;
- `trending` — X momentum.

Legacy `for-you` may be accepted server-side as an alias for `to-review`. Never confuse that old aggregate identifier with X's actual For You timeline.

## Opportunity arbitration

For each promising candidate, decide whether Hamza has a contribution that belongs somewhere.

### Reply

Choose Reply when:

- the payoff belongs inside the active conversation;
- a compact social or technical contribution is available;
- relationship continuity is real and useful;
- the source/thread context makes the Reply stronger than a standalone post.

Do not Reply just because the candidate is fresh or high-distribution.

### Quote

Choose Quote when:

- the source itself is useful context for the reader; and
- Hamza has a distinct thesis, judgment, implication, or evidence synthesis that benefits from the source being attached.

Do not manufacture commentary to borrow distribution.

### Original

Choose Original when the insight stands on its own and can become durable owned profile proof without needing the source attached.

The triggering source can remain research/evidence context even when it is not mentioned in the final post.

### Thread

Choose Thread only when sequence genuinely improves a short-form explanation.

### Article

Choose Article when a durable opportunity needs substantially more evidence, examples, steps, or artifacts than a Thread can comfortably carry. Read `articles.md`.

A trending topic is not, by itself, an Article reason.

### Watch / research / ignore

Use these when the idea is promising but evidence/context is incomplete, the useful seam is already occupied, the contribution is weak, or action would mostly be source paraphrase.

No-action is a valid content decision.

## Freshness and contribution timing

Early participation can matter because the conversation is still forming, but do not sacrifice source inspection or claim confidence solely for speed.

Prefer a candidate when all else is similar and:

- it is fresh enough for the conversation to still be open;
- Hamza has a distinct contribution now;
- source/thread context is clear enough to avoid redundant or mistaken commentary;
- the route fits the act.

Do not use freshness as a reason to invent a stronger thesis.

## Reciprocal and high-value creator interactions

Relationship continuity can be strategically valuable, but preserve the difference between:

- actual reciprocal relationship history;
- a high-value creator worth engaging;
- a signal-watch creator with no relationship yet.

For reciprocal threads, inspect previous/current conversation state before deciding the social act. A warm two-word Reply may be stronger than another technical correction.

For a watch-only creator, earn the interaction from the content. Do not fake familiarity.

## Authenticated For You observation handoff

When an operator workflow is gathering X For You candidates, keep the browser a **read-only sensor** during discovery.

The current Growth OS canonical ingest command is:

`x-for-you-ingest`

The observation batch should preserve, when reliably visible:

- tweet/status ID;
- canonical/observed status URL;
- username;
- exact visible post text;
- observation time;
- feed rank;
- whether the item is promoted;
- observed public metrics.

Do not invent missing metrics or timestamps. Growth OS owns normalization, deduplication, snapshot semantics, and persistence.

A failed/zero-valid browser scan should not be treated as evidence that For You is empty.

## Signal-watch handoff

The current Growth OS operator commands are:

- `x-signal-watchlist` — inspect the explicit watchlist;
- `x-signal-watchlist-update` — replace/update the validated watchlist.

Watchlist membership is operator metadata for discovery recall only. Do not turn the note, membership, or creator fame into a content score or relationship claim.

## Live-context inspection

After Growth OS identifies a candidate worth acting on, use `agent-browser` when exact live X context can change the writing decision:

- source text;
- parent/thread context;
- existing Replies;
- visible metrics;
- whether the author has clarified/corrected the point;
- reciprocal conversation state.

Inspect enough context to find an unused contribution seam. Do not open one tab per candidate or use Browser memory as a substitute for Growth OS state.

## Discovery-to-writing handoff

Before drafting, carry forward only the facts that matter:

- canonical candidate/source;
- current source/thread context;
- active `sourceKinds`;
- relevant relationship state if real;
- measured momentum/freshness when useful;
- the unused contribution seam;
- the selected format/act;
- evidence/claim constraints.

Then write in the active Hamza voice. Discovery source should not dictate rhetorical morphology.

For example, `x_momentum` does not require a quantified hook, `x_for_you` does not require an excited reaction, and `x_creator_latest` does not require a Reply.

## Learning boundary

Discovery provenance is a confounder/context variable when evaluating outcomes.

Preserve it when useful, but do not promote conclusions such as:

- "For You posts always perform better";
- "creator-watch Replies are the growth engine";
- "three sourceKinds means post now";
- "X showed this to us, so X will reward our Quote".

Those are causal/platform claims and require evidence they usually do not have.

A better lesson is narrow and observational, for example: a certain kind of early creator-watch interaction produced stronger follow conversion in a repeated, comparable own-account cohort.
