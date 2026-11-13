import assert from 'node:assert/strict';
import test from 'node:test';
import { explainSchemaViolation } from '../schema-hint.mjs';

// The shapes below are the ones Dev's Zod schemas project to, so the explainer is
// exercised against what 1MCP actually validates.
const fileOpsSchema = {
  type: 'object',
  required: ['operations'],
  properties: {
    operations: {
      type: 'array',
      minItems: 1,
      items: {
        oneOf: [
          { type: 'object', required: ['kind', 'path', 'to'], properties: { kind: { const: 'move' }, path: { type: 'string' }, to: { type: 'string' } } },
          { type: 'object', required: ['kind', 'path'], properties: { kind: { const: 'delete' }, path: { type: 'string' } } },
        ],
      },
    },
    cwd: { type: 'string' },
  },
};

const listDirectorySchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    limit: { type: 'integer', exclusiveMinimum: 0, maximum: 1000 },
    depth: { type: 'integer', minimum: 1, maximum: 4 },
    include_vendor: { type: 'boolean' },
  },
};

test('a misspelled union key names the missing property', () => {
  assert.equal(
    explainSchemaViolation(fileOpsSchema, { operations: [{ op: 'delete', path: 'a.txt' }] }),
    'operations.0: missing required property "kind"',
  );
});

test('an out-of-range value names the bound', () => {
  assert.equal(explainSchemaViolation(listDirectorySchema, { depth: 5 }), 'depth: must be <= 4');
  assert.equal(explainSchemaViolation(listDirectorySchema, { limit: 0 }), 'limit: must be > 0');
  assert.equal(explainSchemaViolation(listDirectorySchema, { path: '' }), 'path: must be at least 1 characters');
});

test('a wrong type names the expected and received type', () => {
  assert.equal(explainSchemaViolation(fileOpsSchema, { operations: 'a.txt' }), 'operations: expected array, received string');
  assert.equal(explainSchemaViolation(fileOpsSchema, null), '(root): expected object, received null');
  assert.equal(explainSchemaViolation(listDirectorySchema, { depth: 2.5 }), 'depth: expected integer, received number');
});

test('a valid argument object reports nothing', () => {
  assert.equal(explainSchemaViolation(fileOpsSchema, { operations: [{ kind: 'delete', path: 'a.txt' }] }), null);
  assert.equal(explainSchemaViolation(fileOpsSchema, { operations: [{ kind: 'move', path: 'a', to: 'b' }], cwd: '/repo' }), null);
  assert.equal(explainSchemaViolation(listDirectorySchema, { depth: 4, limit: 1000 }), null);
});

test('enum, const and unexpected properties are named', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { mode: { enum: ['lines', 'outline'] }, kind: { const: 'delete' } },
  };
  assert.equal(explainSchemaViolation(schema, { mode: 'raw' }), 'mode: expected one of "lines", "outline", received "raw"');
  assert.equal(explainSchemaViolation(schema, { kind: 'move' }), 'kind: expected "delete", received "move"');
  assert.equal(explainSchemaViolation(schema, { extra: 1 }), '(root): unexpected property "extra"');
});

test('a construct the explainer does not model is never reported as a violation', () => {
  // A $ref, an unknown keyword, or a pattern this runtime cannot compile must not
  // invent a failure: the upstream already rejected the call, so silence is safe.
  assert.equal(explainSchemaViolation({ $ref: '#/$defs/thing' }, { anything: true }), null);
  assert.equal(explainSchemaViolation({ type: 'object', properties: { a: { format: 'uri' } } }, { a: 'not a uri' }), null);
  assert.equal(explainSchemaViolation({ type: 'string', pattern: '(' }, 'x'), null);
  assert.equal(explainSchemaViolation(undefined, {}), null);
});

test('at most three violations are reported', () => {
  const schema = { type: 'object', required: ['a', 'b', 'c', 'd'] };
  const detail = explainSchemaViolation(schema, {});
  assert.equal(detail.split('; ').length, 3);
});
