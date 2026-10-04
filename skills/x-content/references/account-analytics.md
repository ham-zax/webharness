# X Account Analytics

Use this reference for own-account outcome learning when authenticated X Account Analytics is available. Treat these pages as read-only measurement surfaces, not as permission to automate X mutations.

## Surfaces

Prefer the authenticated account analytics routes when available:

- Content Posts, 7 days: `https://x.com/i/account_analytics/content?type=posts&sort=date&dir=desc&days=7`
- Content Replies, 7 days: `https://x.com/i/account_analytics/content?type=replies&sort=date&dir=desc&days=7`
- Content All, 7 days: `https://x.com/i/account_analytics/content?type=all&sort=date&dir=desc&days=7`
- Audience: `https://x.com/i/account_analytics/audience`

Use `agent-browser` with the authenticated X session for observation. Browser observation does not grant posting/reply authority.

## Content outcomes

The Content list may expose Date, Impressions, Likes, Replies, and Reposts, with multiple windows and per-output drilldowns. Treat Replies as first-class distribution outcomes rather than measuring only main-feed posts.

A per-output detail page may expose:

- Impressions
- Likes
- Replies
- Reposts
- Engagement rate
- Profile visits
- New follows
- Bookmarks
- Shares
- Media views

Preserve unknowns. A missing field, `-`, `Not enough data yet`, or similar unavailable state is unknown/null, never zero.

## Audience outcomes

Audience views may expose outcome selectors, demographic summaries, devices, country, and active times.

Use audience views to understand who responds and when. Do not treat a selected metric, demographic, device, or active-time heatmap as an X ranking factor. If values are not numerically visible, keep interpretation qualitative.

## Growth OS handoff

When Growth OS is available, keep X Analytics as a measurement source and Growth OS as the state owner.

1. If Analytics reveals an exact owned output ID that Growth OS has not reconciled, record the exact live output before any retry.
2. Persist explicitly observed Content rows through the supported `analytics-record` path with the correct content type and only metrics actually visible.
3. For important experiment posts, high-momentum outputs, relationship Replies, and Article launch posts, add richer detail metrics when observed: `bookmarks`, `shares`, `profileVisits`, `newFollows`, `engagementRatePct`, and `mediaViews`.
4. Persist Audience observations through the supported audience analytics path using only visible structured data.
5. Read richer observations back through the canonical Growth OS analytics interface so exact output IDs join measurement to candidate actions.

Do not drill every old output merely because data exists. Prefer active experiments, recent high-leverage Posts/Replies, surprising outliers, and outputs needed to resolve a growth decision.

## Learning interpretation

Keep the funnel explicit:

`impressions -> engagement -> profile visits -> new follows -> qualified follower / relationship outcome`

A post can win reach and lose conversion, or have modest reach and strong follow conversion.

Compare outputs at similar post ages/windows where possible. Preserve material confounders:

- topic;
- format;
- source momentum;
- discovery provenance (`x_for_you`, `x_creator_latest`, `x_momentum`, `x_latest`) when available;
- reply crowding;
- timing;
- media;
- relationship context;
- hashtag treatment;
- experiment assignment.

Discovery provenance is context, not an X ranking law. Appearing in For You or a creator-watch lane does not by itself explain the outcome.

Use an observed result to create a candidate lesson, not a platform law.
