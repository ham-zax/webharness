import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { renderPairingPrompt } from '../pairing-prompt.mjs';
import { BATCH_CONTRACT, CALL_CONTRACT, CWD_CONTRACT, HTTP_INSTRUCTIONS, RESULT_CONTRACT } from '../protocol.mjs';

const CONTRACTS = [CALL_CONTRACT, RESULT_CONTRACT, BATCH_CONTRACT, CWD_CONTRACT];

const prompt = renderPairingPrompt({
  base: 'https://example.test',
  pairCode: 'ocean-4912-4yw6',
  pairExpiresAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
  defaultCwd: '/home/user/project',
});

test('the pairing prompt carries every shared contract sentence verbatim', () => {
  for (const contract of CONTRACTS) {
    assert.ok(prompt.includes(contract), `pairing prompt is missing: ${contract.slice(0, 60)}...`);
  }
});

test('the server instructions carry the same contract sentences', () => {
  for (const contract of CONTRACTS) {
    assert.ok(HTTP_INSTRUCTIONS.includes(contract), `HTTP_INSTRUCTIONS is missing: ${contract.slice(0, 60)}...`);
  }
});

test('the pairing prompt renders the pairing fields', () => {
  assert.ok(prompt.includes('Base: https://example.test'));
  assert.ok(prompt.includes('Pair code: ocean-4912-4yw6'));
  assert.ok(prompt.includes('Redeem before: 2026-01-01T00:00:00.000Z (single use)'));
  assert.ok(prompt.includes('Access expires: 2026-01-02T00:00:00.000Z'));
  assert.ok(prompt.includes('Default remote cwd: /home/user/project'));
  assert.ok(prompt.includes('POST https://example.test/v1/pair?discover=1'));
  assert.ok(prompt.includes('{"code":"ocean-4912-4yw6"}'));
});

test('the pairing prompt falls back when the session has no default cwd', () => {
  const bare = renderPairingPrompt({
    base: 'https://example.test',
    pairCode: 'code',
    pairExpiresAt: 'a',
    expiresAt: 'b',
  });
  assert.ok(bare.includes('Default remote cwd: (server default)'));
});

test('the pairing prompt never describes a result as an MCP envelope', () => {
  assert.ok(!/preserve both/i.test(prompt));
  assert.ok(!/content text blocks/i.test(prompt));
  assert.ok(prompt.includes('it is not an MCP envelope'));
});

test('bin/adapter keeps no copy of the contract', async () => {
  const source = await readFile(new URL('../../../bin/adapter', import.meta.url), 'utf8');
  for (const contract of CONTRACTS) {
    assert.ok(!source.includes(contract), 'bin/adapter must render the prompt through operator.mjs, not restate the contract');
  }
  assert.ok(!/preserve both/i.test(source));
  assert.ok(source.includes('"$ADAPTER_OPERATOR" prompt'), 'bin/adapter must delegate prompt rendering to operator.mjs');
});
