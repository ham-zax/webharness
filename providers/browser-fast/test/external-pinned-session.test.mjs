import test from 'node:test';
import assert from 'node:assert/strict';
import { ownedBootstrapPage } from '../external-pinned-session.mjs';

const owned = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const existing = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const unrelated = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const version = 'ws://127.0.0.1:9222/devtools/browser/browser-id';
const snapshot = entries => ({ websocket: version, pages: new Map(entries) });

test('provider bootstrap identifies only its newly active blank page', () => {
  const before = snapshot([[existing, 'https://example.com']]);
  const after = snapshot([[existing, 'https://example.com'], [owned, 'about:blank']]);
  assert.equal(ownedBootstrapPage({ before, after, activeTargetId: owned, selectedTargetId: existing }), owned);
});

test('provider bootstrap tolerates attaching a previously initialized pinned session', () => {
  const before = snapshot([[existing, 'https://example.com']]);
  const after = snapshot([[existing, 'https://example.com']]);
  assert.equal(ownedBootstrapPage({ before, after, activeTargetId: existing, selectedTargetId: existing }), null);
});

test('provider refuses ambiguous, modified, foreign or changed-browser pages', () => {
  const before = snapshot([[existing, 'https://example.com']]);
  for (const [after, active, selected] of [
    [snapshot([[existing, 'https://example.com'], [owned, 'https://x.com']]), owned, existing],
    [snapshot([[existing, 'https://example.com'], [owned, 'about:blank']]), unrelated, existing],
    [snapshot([[existing, 'https://example.com'], [owned, 'about:blank'], [unrelated, 'about:blank']]), owned, existing],
    [snapshot([[existing, 'https://example.com'], [owned, 'about:blank']]), owned, unrelated],
    [{ ...snapshot([[existing, 'https://example.com'], [owned, 'about:blank']]), websocket:'ws://127.0.0.1:9222/devtools/browser/restarted' }, owned, existing],
  ]) {
    assert.throws(() => ownedBootstrapPage({ before, after, activeTargetId: active, selectedTargetId: selected }));
  }
});
