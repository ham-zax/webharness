import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBashText, renderEditText, renderWriteText } from '../render.mjs';

function record(overrides = {}) {
  return {
    cwd: '/workspace/repo',
    exit_code: 0,
    output: '',
    output_bytes: 0,
    duration_ms: 1,
    timed_out: false,
    cancelled: false,
    truncated: false,
    full_output_path: null,
    timeout_seconds: 30,
    ...overrides
  };
}

test('successful terminal output remains plain terminal text', () => {
  assert.equal(renderBashText(record({ output: ' M src/foo.ts\n' })), ' M src/foo.ts\n');
});

test('empty successful command gets a minimal acknowledgement', () => {
  assert.equal(renderBashText(record()), 'Command completed.');
});

test('non-zero exit appends only the meaningful status', () => {
  assert.equal(
    renderBashText(record({ exit_code: 1, output: 'Tests: 1 failed, 83 passed\n' })),
    'Tests: 1 failed, 83 passed\n[exit 1]'
  );
});

test('truncation points to the full output handle', () => {
  assert.equal(
    renderBashText(record({
      output: 'tail\n',
      truncated: true,
      full_output_path: '/state/dev/bash-a82f.log'
    })),
    'tail\n[truncated · full: /state/dev/bash-a82f.log]'
  );
});

test('timeout is rendered as a native exceptional annotation', () => {
  assert.equal(
    renderBashText(record({ timed_out: true, exit_code: null, timeout_seconds: 30 })),
    '[timed out after 30s]'
  );
});

test('edit renderer returns one path plus diff without Pi success prose', () => {
  const text = renderEditText('repo/src/foo.ts', '  old\n- value\n+ VALUE');
  assert.equal(text, 'repo/src/foo.ts\n  old\n- value\n+ VALUE');
  assert.doesNotMatch(text, /Successfully replaced|Done!/);
});

test('write renderer is a short creation acknowledgement', () => {
  assert.equal(renderWriteText('repo/src/new.ts'), 'Created repo/src/new.ts');
});

test('signal termination renders a meaningful native annotation', () => {
  assert.equal(
    renderBashText(record({ exit_code: null })),
    '[terminated]'
  );
});
