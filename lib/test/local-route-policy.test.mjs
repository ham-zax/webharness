import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBashText } from '../../providers/pi-dev/render.mjs';
import {
  DEV_COMMAND_PROMOTED_FOOTER,
  hasUnsuccessfulDevCommandFooter,
  isArgumentSensitiveReadOnlyRoute,
  isKnownReadOnlyRoute,
  isPromotedDevCommandResult,
} from '../local-route-policy.mjs';

test('a rendered timeout is detected in text-only command results', () => {
  const text = renderBashText({
    output: 'partial output\n',
    timed_out: true,
    timeout_seconds: 30,
    duration_ms: 30_000,
  });

  assert.equal(hasUnsuccessfulDevCommandFooter(text), true);
});

test('isPromotedDevCommandResult detects promoted command text and structured results without flagging failure', () => {
  const promotedText = [
    'running build...',
    '[still running after 22.0s · promoted to job 1700000000000-abcd1234 (pid 4242, hard cap 120s)]',
    'log: /tmp/jobs/1700000000000-abcd1234.log',
    'exit: /tmp/jobs/1700000000000-abcd1234.exit',
    'Next: wait {"name":"job-1700000000000-abcd1234","condition":{"kind":"file_exists","path":"/tmp/jobs/1700000000000-abcd1234.exit"}}, then read the log.',
  ].join('\n');

  assert.match(promotedText.split('\n')[1], DEV_COMMAND_PROMOTED_FOOTER);
  assert.equal(isPromotedDevCommandResult(promotedText), true);
  assert.equal(isPromotedDevCommandResult({ content: [{ type: 'text', text: promotedText }] }), true);
  assert.equal(isPromotedDevCommandResult(JSON.stringify({ content: [{ type: 'text', text: promotedText }] })), true);
  assert.equal(hasUnsuccessfulDevCommandFooter(promotedText), false);
  assert.equal(hasUnsuccessfulDevCommandFooter({ content: [{ type: 'text', text: promotedText }] }), false);

  assert.equal(isPromotedDevCommandResult('ok\n[exit 0 · 0.1s]'), false);
  assert.equal(hasUnsuccessfulDevCommandFooter('boom\n[exit 1 · 0.1s]'), true);
});

test('ordinary failed output containing prior promoted footer is not misclassified as promoted and _meta takes precedence', () => {
  const mixedStdout = [
    '[still running after 22.0s · promoted to job 1700000000000-abcd1234 (pid 4242, hard cap 120s)]',
    'log: /tmp/jobs/1700000000000-abcd1234.log',
    'exit: /tmp/jobs/1700000000000-abcd1234.exit',
    'Next: wait {"name":"job-1700000000000-abcd1234","condition":{"kind":"file_exists","path":"/tmp/jobs/1700000000000-abcd1234.exit"}}, then read the log.',
    '[exit 1 · 0.1s]',
  ].join('\n');

  assert.equal(isPromotedDevCommandResult(mixedStdout), false);
  assert.equal(hasUnsuccessfulDevCommandFooter(mixedStdout), true);

  assert.equal(
    isPromotedDevCommandResult({ content: [{ type: 'text', text: mixedStdout }], _meta: { 'webharness/command-outcome': 'failed' } }),
    false,
  );
  assert.equal(
    hasUnsuccessfulDevCommandFooter({ content: [{ type: 'text', text: mixedStdout }], _meta: { 'webharness/command-outcome': 'failed' } }),
    true,
  );
  assert.equal(
    isPromotedDevCommandResult({ content: [{ type: 'text', text: 'anything' }], _meta: { 'webharness/command-outcome': 'promoted' } }),
    true,
  );
  assert.equal(
    hasUnsuccessfulDevCommandFooter({ content: [{ type: 'text', text: 'anything' }], _meta: { 'webharness/command-outcome': 'promoted' } }),
    false,
  );
});

test('satori read-only route classification covers all 11 tools', () => {
  const readOnlyTools = [
    'search_codebase', 'architecture_overview', 'continue_search', 'call_graph',
    'trace_path', 'find_references', 'detect_changes', 'file_outline',
    'read_file', 'list_codebases',
  ];
  for (const tool of readOnlyTools) {
    assert.equal(isKnownReadOnlyRoute('satori', tool, {}), true, `expected satori/${tool} to be read-only`);
    assert.equal(isArgumentSensitiveReadOnlyRoute('satori', tool), false);
  }
  assert.equal(isArgumentSensitiveReadOnlyRoute('satori', 'manage_index'), true);
  assert.equal(isKnownReadOnlyRoute('satori', 'manage_index', { action: 'status', path: '/repo' }), true);
  assert.equal(isKnownReadOnlyRoute('satori', 'manage_index', { action: 'create', path: '/repo' }), false);
  assert.equal(isKnownReadOnlyRoute('satori', 'manage_index', { action: 'sync', path: '/repo' }), false);
  assert.equal(isKnownReadOnlyRoute('satori', 'manage_index', {}), false);
  assert.equal(isKnownReadOnlyRoute('satori', 'manage_index', undefined), false);
});
