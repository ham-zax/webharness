import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const patched = process.env.WEBHARNESS_PATCHED_1MCP;
const pristine = process.env.WEBHARNESS_PRISTINE_1MCP;

test('optional pinned runtime qualification preserves compact instruction output', { skip: !patched || !pristine }, async () => {
  const moduleAt = (root, file) => import(pathToFileURL(join(root, 'build', file)).href);
  const template = await readFile(new URL('../../config/templates/instructions-template.md', import.meta.url), 'utf8');
  const oldTypes = await moduleAt(patched, 'core/instructions/templateTypes.js');
  const oldAggregator = await moduleAt(patched, 'core/instructions/instructionAggregator.js');
  const newAggregator = await moduleAt(pristine, 'core/instructions/instructionAggregator.js');
  const oldValidator = await moduleAt(patched, 'core/instructions/templateValidator.js');
  const newValidator = await moduleAt(pristine, 'core/instructions/templateValidator.js');
  const connections = new Map(['zulu', 'missing', 'alpha'].map(name => [name, { name, status: 'connected', tags: [] }]));
  function aggregator(Aggregator) {
    const value = new Aggregator();
    value.setInstructions('alpha', 'A & B <tag> `tick`\nUnicode: héllo🌍');
    value.setInstructions('zulu', 'Second\nline & more');
    return value;
  }
  const before = aggregator(oldAggregator.InstructionAggregator).getFilteredInstructions({}, connections);
  const afterPatched = aggregator(oldAggregator.InstructionAggregator).getFilteredInstructions({ customTemplate: template }, connections);
  const afterPristine = aggregator(newAggregator.InstructionAggregator).getFilteredInstructions({ customTemplate: template }, connections);
  assert.equal(oldTypes.DEFAULT_INSTRUCTION_TEMPLATE, template);
  assert.equal(afterPatched, before);
  assert.equal(afterPristine, before);
  assert.equal(oldValidator.validateTemplateContent(template).valid, true);
  assert.equal(newValidator.validateTemplateContent(template).valid, true);
  assert.equal(before, '<alpha>\nA & B <tag> `tick`\nUnicode: héllo🌍\n</alpha>\n\n<zulu>\nSecond\nline & more\n</zulu>\n\nTools are namespaced by server as `{server}_{tool}`.');
});
