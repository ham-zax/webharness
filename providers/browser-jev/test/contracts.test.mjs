import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPERATION_KINDS,
  TERMINAL_STATUSES,
  sanitizeSnapshot,
  validateRunId,
  validateStartArguments,
  verifySuccess
} from '../contracts.mjs';

const validArgs = () => ({
  url: 'https://example.com/',
  goal: 'Confirm the page and stop.',
  scenario: {
    browser_target: 'linux',
    browser_backend: 'clearcote',
    browser_profile: 'x-main',
    success: { title_contains: ['Example Domain'] }
  }
});

test('validates and normalizes a start request', () => {
  assert.deepEqual(validateStartArguments(validArgs()), validArgs());
  assert.deepEqual(validateStartArguments({
    url: 'https://example.com',
    goal: 'Inspect it',
    scenario: { success: { url_contains: ['example.com'] } }
  }), {
    url: 'https://example.com/',
    goal: 'Inspect it',
    scenario: {
      browser_target: 'windows',
      browser_backend: 'chrome',
      browser_profile: undefined,
      success: { url_contains: ['example.com'] }
    }
  });
});

test('rejects invalid URLs, routing, profiles, and unknown keys', () => {
  for (const [mutate, pattern] of [
    [args => { args.url = 'file:///etc/passwd'; }, /url must be an HTTP or HTTPS URL/],
    [args => { args.goal = ' '; }, /goal must be a non-empty string/],
    [args => { args.extra = true; }, /unknown key.*extra/i],
    [args => { args.scenario.extra = true; }, /unknown key.*extra/i],
    [args => { args.scenario.browser_target = 'mac'; }, /browser_target/],
    [args => { args.scenario.browser_backend = 'firefox'; }, /browser_backend/],
    [args => { args.scenario.browser_target = 'windows'; }, /Windows supports only/],
    [args => { args.scenario.browser_profile = '../escape'; }, /browser_profile/],
    [args => { args.scenario.browser_profile = '.'; }, /browser_profile/]
  ]) {
    const args = validArgs();
    mutate(args);
    assert.throws(() => validateStartArguments(args), pattern);
  }
});

test('requires at least one non-empty success check and rejects unknown success keys', () => {
  for (const success of [
    {},
    { url_contains: [] },
    { text_contains: [''] },
    { title_contains: 'Example' },
    { selector: '#done' },
    { required_operations: ['SCROLL'] },
    { required_operations: ['toString'] }
  ]) {
    const args = validArgs();
    args.scenario.success = success;
    assert.throws(() => validateStartArguments(args), /success|required_operations|unknown key/i);
  }
});

test('fixes the public operation enum and terminal statuses', () => {
  assert.deepEqual(OPERATION_KINDS, {
    CLICK: 'click',
    TYPE_TEXT: 'fill',
    SELECT: 'select',
    WAIT: 'wait'
  });
  assert.deepEqual([...TERMINAL_STATUSES], ['done', 'blocked', 'failed', 'stopped']);
});

test('validates an opaque run id and rejects extra arguments', () => {
  assert.equal(validateRunId({ run_id: '01K5B8ZCQ9N9M0D4R4CZP4MZB2' }), '01K5B8ZCQ9N9M0D4R4CZP4MZB2');
  assert.throws(() => validateRunId({ run_id: '' }), /run_id/);
  assert.throws(() => validateRunId({ run_id: 'ok', extra: true }), /unknown key.*extra/i);
});

test('sanitizes snapshots with explicit nested allowlists', () => {
  const clean = sanitizeSnapshot({
    goal: 'Find an article',
    status: 'ready',
    elapsed_ms: 41,
    page: {
      url: 'https://example.com',
      title: 'Example',
      text: 'Visible',
      scroll: { y: 0, max_y: 100 },
      actions: [{ id: 'a1', kind: 'click', label: 'More', node: 99, selector: '#secret' }],
      screenshot: 'base64',
      fingerprint: 'secret'
    },
    elements: [{ id: 'a1', kind: 'click', label: 'More', value: null, node: 99, selector: '#secret' }],
    decision: {
      operation: 'CLICK', choice: 'a1', target: 'More', confidence: 0.8,
      latency_ms: 10, probabilities: { a1: 0.8 }, usage: { input_tokens: 1 }, request: { api_key: 'secret' }, raw_answers: ['x']
    },
    history: [{
      step: 1, action: 'More', kind: 'click', choice: 'a1', operation: 'CLICK', target: 'More',
      confidence: 0.8, latency_ms: 10, text: null, text_helper: null, text_latency_ms: 0,
      page_changed: true, url: 'https://example.com/more', executed_ms: 15, elapsed_ms: 20,
      probability: 0.8, usage: { output_tokens: 1 }, selector: '#secret'
    }],
    request: { api_key: 'secret' },
    raw_answers: ['secret'],
    screenshot: 'secret',
    browser: { endpoint: 'secret' },
    unknown: 'secret'
  });

  assert.deepEqual(clean, {
    goal: 'Find an article',
    status: 'ready',
    elapsed_ms: 41,
    page: {
      url: 'https://example.com',
      title: 'Example',
      text: 'Visible',
      scroll: { y: 0, max_y: 100 }
    },
    elements: [{ id: 'a1', kind: 'click', label: 'More', value: null }],
    decision: {
      operation: 'CLICK', choice: 'a1', target: 'More', confidence: 0.8,
      latency_ms: 10, probabilities: { a1: 0.8 }, usage: { input_tokens: 1 }
    },
    history: [{
      step: 1, action: 'More', kind: 'click', choice: 'a1', operation: 'CLICK', target: 'More',
      confidence: 0.8, latency_ms: 10, text: null, text_helper: null, text_latency_ms: 0,
      page_changed: true, url: 'https://example.com/more', executed_ms: 15, elapsed_ms: 20,
      probability: 0.8, usage: { output_tokens: 1 }
    }]
  });
  assert.equal(JSON.stringify(clean).includes('secret'), false);
});

test('DONE verification requires visible checks and requested operation history', () => {
  const result = verifySuccess({
    page: { url: 'https://en.wikipedia.org/wiki/G%C3%B6del%27s_incompleteness_theorems', title: 'Gödel', text: 'Incompleteness theorem' },
    history: [{ kind: 'click' }]
  }, {
    url_contains: ['/wiki/'],
    text_contains: ['Incompleteness theorem'],
    required_operations: ['TYPE_TEXT']
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.checks.required_operations.TYPE_TEXT, { expected_kind: 'fill', passed: false });
});

test('verification requires every requested string and operation', () => {
  const result = verifySuccess({
    page: { url: 'https://example.com/done', title: 'Example Done', text: 'Alpha Beta' },
    history: [{ kind: 'fill' }, { kind: 'click' }]
  }, {
    url_contains: ['example.com', '/done'],
    title_contains: ['Example', 'Missing'],
    text_contains: ['Alpha', 'Beta'],
    required_operations: ['TYPE_TEXT', 'CLICK']
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.checks.title_contains, [
    { expected: 'Example', passed: true },
    { expected: 'Missing', passed: false }
  ]);
  assert.equal(result.checks.required_operations.TYPE_TEXT.passed, true);
  assert.equal(result.checks.required_operations.CLICK.passed, true);
});
