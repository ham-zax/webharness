# Retry-safe reusable WebSession pairing - Intent

## TaskIntentDraft

- Requested outcome: Recover pairing after lost responses and reuse one code across chats for one hour, with a fixed 24-hour session after first redemption.
- Goal: Recover pairing after lost responses and reuse one code across chats for one hour, with a fixed 24-hour session after first redemption.
- Success evidence:
- none
- Stop condition: Stop when success evidence is satisfied or a blocker/risk requires pause.
- Non-goals:
- No new transport, machine binding, independent chat lanes, or service restart.
- Scope: Pairing recovery, staged client review fixes, regression tests, and local integration on main. The user performs the service restart.
- Change kinds:
- bugfix
- Risk hints:
- Authentication and persisted expiry semantics

## BaselineReadSetHint

- providers/websession-adapter/store.mjs
- docs/websession-clients.md

## BaselineUsageDraft

- Required baseline refs:
- providers/websession-adapter/store.mjs
- docs/websession-clients.md
- Acknowledged before plan:
- none
- Cited in plan:
- none
- Missing refs:
- providers/websession-adapter/store.mjs
- docs/websession-clients.md
- Advisory decision: needs-baseline-readback

## ImpactStatementDraft

- Compatibility boundary: Existing bearer tokens, POST pair body, operation nonce rules, and turn fences remain valid.
- Affected layers:
- authentication
- Owners:
- AdapterStore
- Invariants:
- Retries return one token and never extend deadlines. Fresh codes use one clean policy without schema migration or legacy handling.
- Non-goals:
- No new transport, machine binding, independent chat lanes, or service restart.

These records are Method Pack drafts / hints, not authoritative runtime decisions.
