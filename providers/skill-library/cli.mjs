#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SkillLibrary } from './library.mjs';
import { readApproved } from './files.mjs';

const DEFAULT_POLICY = fileURLToPath(new URL('../../skill-library/policy.json', import.meta.url));

export async function runCli(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!['--policy', '--query', '--collection', '--id', '--revision', '--file', '--cursor', '--limit', '--destination'].includes(key)
        || rest[index + 1] === undefined || options[key] !== undefined) throw new Error('invalid or duplicate CLI option');
    options[key] = rest[index + 1];
  }
  if (command === 'help' || command === '--help') return {
    usage: 'webharness skills find|read|check|compile|export [--policy FILE] [--query TEXT] [--collection NAME] [--id ID --revision SHA256 --file PACK_RELATIVE_FILE --cursor CURSOR] [--destination NEW_DIRECTORY]',
  };
  const allowedOptions = {
    find: ['--query', '--collection', '--limit', '--cursor'],
    read: ['--id', '--revision', '--file', '--cursor'],
    check: [], compile: [], export: ['--destination'],
  };
  if (!Object.hasOwn(allowedOptions, command) || Object.keys(options).some(key => key !== '--policy' && !allowedOptions[command].includes(key))) {
    throw new Error('unknown command or option does not apply to this command');
  }
  const library = await SkillLibrary.open(options['--policy'] || DEFAULT_POLICY);
  if (command === 'find') return library.find({ query: options['--query'], collection: options['--collection'],
    limit: options['--limit'] === undefined ? undefined : Number(options['--limit']), cursor: options['--cursor'] });
  if (command === 'read') return library.read({ id: options['--id'], revision: options['--revision'], file: options['--file'], cursor: options['--cursor'] });
  const catalog = await library.catalog();
  const catalogPath = path.join(library.policy.root, 'catalog.json');
  const rendered = `${JSON.stringify(catalog, null, 2)}\n`;
  if (command === 'check') {
    const actual = await readApproved(library.policy.root, 'catalog.json');
    if (actual.toString('utf8') !== rendered) throw new Error('catalog is stale; run webharness skills compile');
    return { status: 'ok', skills: catalog.skills.length, revision: catalog.revision,
      verification: 'declared files present, text readable, generated metadata current; runtime compatibility not inferred' };
  }
  if (command === 'compile') {
    const temp = `${catalogPath}.${process.pid}.tmp`;
    await fs.writeFile(temp, rendered, { flag: 'wx', mode: 0o644 });
    try { await fs.rename(temp, catalogPath); }
    finally { await fs.rm(temp, { force: true }); }
    return { status: 'compiled', skills: catalog.skills.length, catalog: catalogPath };
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
        const bytes = await readApproved(pack.root, file);
        const target = path.join(destination, rawPack.root, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes, { flag: 'wx' });
      }
    }
    await fs.writeFile(path.join(destination, 'policy.json'), `${JSON.stringify(library.policy.raw, null, 2)}\n`, { flag: 'wx' });
    // Recompute from exported bytes so source updates cannot leave a mixed export
    // silently advertising the old revision.
    const exported = await SkillLibrary.open(path.join(destination, 'policy.json'));
    const exportedCatalog = await exported.catalog();
    if (exportedCatalog.revision !== catalog.revision) throw new Error('source changed during export; exported catalog was not published');
    await fs.writeFile(path.join(destination, 'catalog.json'), rendered, { flag: 'wx' });
    return { status: 'exported', destination, skills: catalog.skills.length };
  }
  throw new Error('unknown skills command; use webharness skills help');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${error.code ?? 'SKILLS_CLI_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
}
