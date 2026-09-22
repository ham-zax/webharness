import assert from 'node:assert/strict';
import test from 'node:test';

import { JEV_ENV_KEYS, loadWorkerEnvironment } from '../credentials.mjs';

const ownedFile = (overrides = {}) => ({
  isFile: () => true,
  uid: process.getuid(),
  size: 20,
  ...overrides
});

test('exports the exact credential allowlist', () => {
  assert.deepEqual(JEV_ENV_KEYS, [
    'TYPESAFE_API_KEY', 'TYPESAFE_MODEL', 'TEXT_MODEL_API_KEY',
    'TEXT_MODEL_BASE_URL', 'TEXT_MODEL', 'TEXT_MODEL_REASONING'
  ]);
});

test('loads only allowlisted values from direct server environment', async () => {
  const result = await loadWorkerEnvironment({
    baseEnv: { TYPESAFE_API_KEY: 'type-secret', TYPESAFE_MODEL: 'model', PATH: '/bin', BU_NAME: 'default' }
  });
  assert.deepEqual(result, { TYPESAFE_API_KEY: 'type-secret', TYPESAFE_MODEL: 'model' });
});

test('rejects missing TypeSafe credentials without exposing values', async () => {
  await assert.rejects(loadWorkerEnvironment({ baseEnv: { TEXT_MODEL_API_KEY: 'helper-secret' } }), /TYPESAFE_API_KEY/);
});

test('validates and loads an absolute owner credential file', async () => {
  const result = await loadWorkerEnvironment({
    file: '/private/jev.env',
    baseEnv: { TYPESAFE_API_KEY: 'old', TYPESAFE_MODEL: 'jev-custom', TEXT_MODEL: 'old-model', PATH: '/bin' },
    lstat: async () => ownedFile({ size: 100 }),
    readFile: async () => [
      '# server-side model credentials',
      'TYPESAFE_API_KEY=file-secret',
      'TEXT_MODEL="small-model"',
      ''
    ].join('\n')
  });
  assert.deepEqual(result, {
    TYPESAFE_API_KEY: 'file-secret',
    TYPESAFE_MODEL: 'jev-custom',
    TEXT_MODEL: 'small-model'
  });
});

test('rejects unknown keys without including their values', async () => {
  const error = await assert.rejects(
    loadWorkerEnvironment({
      file: '/private/jev.env',
      baseEnv: {},
      lstat: async () => ownedFile(),
      readFile: async () => 'TYPESAFE_API_KEY=x\nPATH=do-not-leak\n'
    }),
    /permits only/
  );
  assert.equal(String(error).includes('do-not-leak'), false);
});

test('rejects unsafe file metadata and malformed contents', async () => {
  const cases = [
    [{ file: 'relative.env' }, /absolute path/],
    [{ lstat: async () => ownedFile({ isFile: () => false }) }, /regular file/],
    [{ lstat: async () => ownedFile({ uid: process.getuid() + 1 }) }, /current user/],
    [{ lstat: async () => ownedFile({ size: 64 * 1024 + 1 }) }, /64 KiB/],
    [{ readFile: async () => 'TYPESAFE_API_KEY=x\nnot an assignment\n' }, /malformed/],
    [{ readFile: async () => 'TYPESAFE_API_KEY=\n' }, /TYPESAFE_API_KEY/]
  ];
  for (const [overrides, pattern] of cases) {
    await assert.rejects(loadWorkerEnvironment({
      file: '/private/jev.env',
      baseEnv: {},
      lstat: async () => ownedFile(),
      readFile: async () => 'TYPESAFE_API_KEY=x\n',
      ...overrides
    }), pattern);
  }
});

test('revalidates a file each time it is loaded', async () => {
  let calls = 0;
  const lstat = async () => {
    calls += 1;
    return calls === 1 ? ownedFile() : ownedFile({ uid: process.getuid() + 1 });
  };
  const options = {
    file: '/private/jev.env',
    baseEnv: {},
    lstat,
    readFile: async () => 'TYPESAFE_API_KEY=x\n'
  };
  assert.deepEqual(await loadWorkerEnvironment(options), { TYPESAFE_API_KEY: 'x' });
  await assert.rejects(loadWorkerEnvironment(options), /current user/);
});
