#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SkillLibrary } from './library.mjs';
import { readApprovedEntry } from './files.mjs';

const DEFAULT_POLICY = fileURLToPath(new URL('../../skill-library/policy.json', import.meta.url));

export async function runCli(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!['--policy', '--query', '--collection', '--id', '--revision', '--file', '--cursor', '--limit', '--destination', '--mode', '--context'].includes(key)
        || rest[index + 1] === undefined || options[key] !== undefined) throw new Error('invalid or duplicate CLI option');
    options[key] = rest[index + 1];
  }
  if (command === 'help' || command === '--help') return {
    usage: 'webharness skills find|read|check|export [--policy FILE] [--query TEXT --collection NAME --mode lexical|jev --context TEXT] [--id ID --revision SHA256 --file PACK_RELATIVE_FILE --cursor CURSOR] [--destination NEW_DIRECTORY]',
  };
  const allowedOptions = {
    find: ['--query', '--collection', '--limit', '--cursor', '--mode', '--context'],
    read: ['--id', '--revision', '--file', '--cursor'],
    check: [], export: ['--destination'],
  };
  if (!Object.hasOwn(allowedOptions, command) || Object.keys(options).some(key => key !== '--policy' && !allowedOptions[command].includes(key))) {
    throw new Error('unknown command or option does not apply to this command');
  }
  const library = await SkillLibrary.open(options['--policy'] || DEFAULT_POLICY);
  if (command === 'find') return library.find({ query: options['--query'], collection: options['--collection'],
    limit: options['--limit'] === undefined ? undefined : Number(options['--limit']), cursor: options['--cursor'],
    mode: options['--mode'], context: options['--context'] });
  if (command === 'read') return library.read({ id: options['--id'], revision: options['--revision'], file: options['--file'], cursor: options['--cursor'] });
  const catalog = await library.catalog();
  if (command === 'check') {
    return { status: 'ok', skills: catalog.skills.length, revision: catalog.revision,
      verification: 'declared files present and text readable; runtime compatibility not inferred' };
  }
  if (command === 'export') {
    if (!options['--destination']) throw new Error('export requires --destination NEW_DIRECTORY');
    const destination = path.resolve(options['--destination']);
    // Create-only: a failed export is left for inspection, never overwrite or
    // delete operator files. Only approved content and fixed provenance travel.
    await fs.mkdir(destination);
    for (const pack of library.policy.packs) {
      const rawPack = library.policy.raw.packs.find(item => item.id === pack.id);
      const files = new Set(pack.skills.flatMap(skill => skill.readable));
      if (!files.has('LICENSE') || !files.has('PROVENANCE.md')) {
        throw new Error('export requires LICENSE and PROVENANCE.md in the explicit readable policy');
      }
      for (const file of files) {
        const { bytes, executeBits } = await readApprovedEntry(pack.root, file);
        const target = path.join(destination, rawPack.root, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const mode = 0o644 | executeBits;
        const output = await fs.open(target, 'wx', mode);
        try {
          await output.writeFile(bytes);
          // writeFile's mode is filtered by umask; restore only approved execute
          // bits, never source setuid, setgid or sticky bits.
          await output.chmod(mode);
        } finally {
          await output.close();
        }
      }
    }
    await fs.writeFile(path.join(destination, 'policy.json'), `${JSON.stringify(library.policy.raw, null, 2)}\n`, { flag: 'wx' });
    // Validate relocated bytes and execute bits without writing a metadata copy.
    const exported = await SkillLibrary.open(path.join(destination, 'policy.json'));
    const exportedCatalog = await exported.catalog();
    if (exportedCatalog.revision !== catalog.revision) throw new Error('source changed during export; exported files failed verification');
    return { status: 'exported', destination, skills: catalog.skills.length };
  }
  throw new Error('unknown skills command; use webharness skills help');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${error.code ?? 'SKILLS_CLI_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
}
