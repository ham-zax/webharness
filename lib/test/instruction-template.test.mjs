import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const EXPECTED_TEMPLATE = [
  '{{#each servers}}{{#if hasInstructions}}<{{name}}>',
  '{{instructions}}',
  '</{{name}}>',
  '',
  '{{/if}}{{/each}}Tools are namespaced by server as `{server}_{tool}`.',
].join('\n');

const EXPECTED_RENDERED = [
  '<alpha>',
  'A & B <tag> `tick`',
  'Unicode: héllo🌍',
  '</alpha>',
  '',
  '<zulu>',
  'Second',
  'line & more',
  '</zulu>',
  '',
  'Tools are namespaced by server as `{server}_{tool}`.',
].join('\n');

function detectInstalled1McpRoot() {
  if (process.env.WEBHARNESS_1MCP_ROOT) return process.env.WEBHARNESS_1MCP_ROOT;
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const candidate = join(globalRoot, '@1mcp', 'agent');
    if (existsSync(join(candidate, 'build', 'core', 'instructions', 'instructionAggregator.js'))) return candidate;
  } catch {
    // Portable CI environments may not install global @1mcp/agent.
  }
  return null;
}

function populateFixture(Aggregator) {
  const value = new Aggregator();
  value.setInstructions('alpha', 'A & B <tag> `tick`\nUnicode: héllo🌍');
  value.setInstructions('zulu', 'Second\nline & more');
  return value;
}

test('declarative instruction template matches canonical compact layout', async () => {
  const template = await readFile(new URL('../../config/templates/instructions-template.md', import.meta.url), 'utf8');
  assert.equal(template, EXPECTED_TEMPLATE);
  assert.ok(!template.includes('{{{'), '1MCP compiles templates with noEscape; triple-stache is unnecessary');
});

const installedRoot = detectInstalled1McpRoot();
const requireQualification = process.env.WEBHARNESS_REQUIRE_1MCP_QUALIFICATION === '1';
const pristineRoot = process.env.WEBHARNESS_PRISTINE_1MCP || null;
const legacyPatchedRoot = process.env.WEBHARNESS_PATCHED_1MCP || null;

test(
  'pinned 1MCP InstructionAggregator and validator preserve exact compact output',
  { skip: !installedRoot && !requireQualification ? 'pinned @1mcp/agent is not installed globally' : false },
  async () => {
    assert.ok(installedRoot && existsSync(join(installedRoot, 'build', 'core', 'instructions', 'instructionAggregator.js')), 'WEBHARNESS_REQUIRE_1MCP_QUALIFICATION=1 requires an installed @1mcp/agent runtime');
    const moduleAt = (root, file) => import(pathToFileURL(join(root, 'build', file)).href);
    const template = await readFile(new URL('../../config/templates/instructions-template.md', import.meta.url), 'utf8');
    const connections = new Map(['zulu', 'missing', 'alpha'].map(name => [name, { name, status: 'connected', tags: [] }]));

    const managedRuntimeConfig = {
      configuredTargets: { mcpServers: {}, mcpTemplates: {} },
      instructionTemplates: { webharness: { initialization: template, cli: template } },
      publishedInstructionTemplates: { webharness: { initialization: template, cli: template } },
      activeInstructionTemplate: 'webharness',
    };
    const verifyRuntime = async root => {
      const { InstructionAggregator } = await moduleAt(root, 'core/instructions/instructionAggregator.js');
      const { validateTemplateContent } = await moduleAt(root, 'core/instructions/templateValidator.js');
      const { mcpServerConfigSchema } = await moduleAt(root, 'core/types/transport.js');
      assert.equal(validateTemplateContent(template).valid, true);
      const parsedSchema = mcpServerConfigSchema.safeParse({
        mcpServers: {},
        instructionTemplates: managedRuntimeConfig.instructionTemplates,
        publishedInstructionTemplates: managedRuntimeConfig.publishedInstructionTemplates,
        activeInstructionTemplate: managedRuntimeConfig.activeInstructionTemplate,
      });
      assert.equal(parsedSchema.success, true);

      // Modern 2026-07-28 HTTP uses runtimeConfiguration without config.customTemplate.
      const modernAgg = populateFixture(InstructionAggregator);
      modernAgg.setRuntimeInstructionConfiguration(managedRuntimeConfig);
      const renderedModern = modernAgg.getFilteredInstructions({}, connections);
      assert.equal(renderedModern, EXPECTED_RENDERED);

      // Legacy HTTP fallback with customTemplate produces identical output.
      const legacyAgg = populateFixture(InstructionAggregator);
      const renderedLegacy = legacyAgg.getFilteredInstructions({ customTemplate: template }, connections);
      assert.equal(renderedLegacy, EXPECTED_RENDERED);
      return renderedModern;
    };

    const renderedInstalled = await verifyRuntime(installedRoot);
    if (pristineRoot) {
      const renderedPristine = await verifyRuntime(pristineRoot);
      assert.equal(renderedPristine, renderedInstalled);
    }

    if (legacyPatchedRoot) {
      const oldTypes = await moduleAt(legacyPatchedRoot, 'core/instructions/templateTypes.js');
      const oldAggregator = await moduleAt(legacyPatchedRoot, 'core/instructions/instructionAggregator.js');
      const before = populateFixture(oldAggregator.InstructionAggregator).getFilteredInstructions({}, connections);
      assert.equal(oldTypes.DEFAULT_INSTRUCTION_TEMPLATE.trimEnd(), template.trimEnd());
      assert.equal(before, EXPECTED_RENDERED);
    }
  },
);
