# Retry-safe reusable pairing

Status: implementation and local checks complete. The user restarts services.

Authority: the user requests a one-hour pairing code, a roughly 24-hour session,
and reuse across branched chats. Implementation is authorized. Deployment is separate.

Baseline: HEAD `f0b853b`, with eight pre-existing staged paths from the earlier review.
The user later authorizes integration of the staged changes and pairing work.
The review delegate remains read-only. Fix its confirmed blockers before committing on main.
Read-set: adapter store, pair handler, operator, connection script, pairing prompt,
Python client, pairing/store HTTP tests, and `docs/websession-clients.md`.
The store currently consumes the code before sending the response, so a lost
response prevents recovery. The same bearer already permits multiple clients.

## Design

- New codes default to 3600 seconds. Session lifetime defaults to 86400 seconds.
- New codes use a 12-character random suffix. Generate a fresh code and prompt.
- Reuse the existing state format. No migration or legacy pairing path is needed,
  as the user explicitly requests a clean policy for fresh sessions.
- The stored capability timestamps encode the requested lifetime until first
  redemption. The existing `redeemed_ms` records that activation has occurred.
- First redemption atomically starts the session lifetime. Concurrent redemption
  and retry return the same token and expiry. Neither deadline slides.
- Revocation blocks both pairing and bearer use. Expired codes cannot retrieve
  a token, but the existing token works until its own expiry.
- Keep the POST body and response contract. Add session-duration metadata to the
  operator output. The prompt describes first-use expiry instead of a guessed timestamp.
- Share the token across chats. Cwd and optional turn fences remain shared.
  Independent chats must not invent separate turn counters on one bearer.
- Alternatives: response replay keyed by a client nonce only solves retries,
  while issuing a new token per redemption does not meet the requested shared-token behavior.

## Work and checks

TDD Route: off / skipped, from local Aegis configuration. Add meaningful
regression coverage with implementation, without strict test-first sequencing.

1. Update store issuance, activation, expiry and revocation without a migration.
2. Update operator and connect defaults, generated instructions, and client docs.
3. Check repeated and concurrent HTTP pairing, dropped-response recovery, fixed
   expiry, independent token use after code expiry, revocation, and restart recovery.
4. Run adapter tests once after focused checks. Run shellcheck on `bin/adapter`.
5. Review the diff and report local evidence, remaining risks, and activation steps.

No production capability is issued and no live service restarts in this task.
