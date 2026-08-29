import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderBashText,
  renderEditPartial,
  renderEditText,
  renderFileOpsPartial,
  renderFileOpsText,
  renderWriteText,
} from '../render.mjs';

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
    spool_truncated: false,
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

test('capped retained output is labeled as partial rather than full', () => {
  assert.equal(
    renderBashText(record({
      output: 'tail\n',
      truncated: true,
      spool_truncated: true,
      full_output_path: '/state/dev/bash-capped.log'
    })),
    'tail\n[truncated · retained output capped · file: /state/dev/bash-capped.log]'
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



test('edit partial renderer distinguishes applied failed uncertain and unattempted targets', () => {
  const text = renderEditPartial({
    applied: ['a.txt'],
    failed: [{ path: 'b.txt', message: 'file changed since preflight; reread and reconcile' }],
    uncertain: [{ path: 'c.txt', message: 'write state unknown; reread target before retrying' }],
    unattempted: ['d.txt'],
  });
  assert.equal(text, [
    'EDIT_PARTIAL',
    'applied: a.txt',
    'failed: b.txt: file changed since preflight; reread and reconcile',
    'uncertain: c.txt: write state unknown; reread target before retrying',
    'unattempted: d.txt',
  ].join('\n'));
});

test('write renderer is a short creation acknowledgement', () => {
  assert.equal(renderWriteText('repo/src/new.ts'), 'Created repo/src/new.ts');
});

test('file_ops renderer returns compact path-oriented success output', () => {
  const text = renderFileOpsText({
    operations: [
      { kind: 'move', path: 'src/from.bin', to: 'src/to.bin' },
      { kind: 'delete', path: 'src/old.bin' },
    ],
  });
  assert.equal(text, 'R src/from.bin -> src/to.bin\nD src/old.bin');
});

test('file_ops partial renderer preserves completed failed uncertain and unattempted structure', () => {
  const text = renderFileOpsPartial({
    completed: [{ kind: 'delete', path: 'a.bin' }],
    failed: [{ kind: 'delete', path: 'b.bin', message: 'changed since preflight' }],
    uncertain: [{
      kind: 'move',
      path: 'c.bin',
      to: 'd.bin',
      message: 'destination link was created; inspect both paths before retrying',
      sideEffects: { destination_link_created: true, expected_source_entry_retained: true },
    }],
    unattempted: [{ kind: 'delete', path: 'e.bin' }],
  });
  assert.equal(text, [
    'FILE_OPS_PARTIAL',
    'completed: delete a.bin',
    'failed: delete b.bin: changed since preflight',
    'uncertain: move c.bin -> d.bin: destination link was created; inspect both paths before retrying [destination_link_created=true, expected_source_entry_retained=true]',
    'unattempted: delete e.bin',
  ].join('\n'));
});

test('signal termination renders a meaningful native annotation', () => {
  assert.equal(
    renderBashText(record({ exit_code: null })),
    '[terminated]'
  );
});
