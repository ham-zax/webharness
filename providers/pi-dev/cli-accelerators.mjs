import fsSync, { constants as fsConstants } from 'node:fs';
import path from 'node:path';

// Ordered list of optional host CLI accelerators probed synchronously once at
// Dev startup. Note: explicitly probes `ast-grep` (never `sg`) so Linux
// shadow `/usr/bin/sg` on bare hosts is never misreported as ast-grep.
export const HOST_CLI_ACCELERATORS = Object.freeze([
  'ast-grep',
  'jq',
  'yq',
  'fd',
  'pueue',
  'difft',
  'just',
  'scc',
  'hyperfine',
  'mcp-inspector',
]);

const ACCELERATOR_HINTS = Object.freeze({
  'ast-grep': 'AST codemods via ast-grep',
  jq: 'JSON queries via jq',
  yq: 'YAML queries via yq',
  fd: 'fast filename search via fd',
  pueue: 'queued heavy jobs via pueue',
  difft: 'structural diffs via DFT_DISPLAY=inline DFT_COLOR=never GIT_EXTERNAL_DIFF=difft git --no-pager diff',
  just: 'repo recipes via just',
  scc: 'LOC counts via scc',
  hyperfine: 'CLI benchmarks via hyperfine',
  'mcp-inspector': 'MCP probing via mcp-inspector --cli',
});

function isExecutableFile(fullPath) {
  try {
    const stat = fsSync.statSync(fullPath);
    if (!stat.isFile()) return false;
    fsSync.accessSync(fullPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function detectHostCliAccelerators(envPath = process.env.PATH) {
  if (typeof envPath !== 'string' || envPath.length === 0) return [];
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  if (dirs.length === 0) return [];
  const found = [];
  for (const name of HOST_CLI_ACCELERATORS) {
    for (const dir of dirs) {
      if (isExecutableFile(path.join(dir, name))) {
        found.push(name);
        break;
      }
    }
  }
  return found;
}

export function formatCliAcceleratorsInstruction(accelerators) {
  if (!Array.isArray(accelerators) || accelerators.length === 0) return null;
  const hints = accelerators.map(name => ACCELERATOR_HINTS[name]).filter(Boolean);
  const guidance = hints.length > 0
    ? `prefer for ${hints.join(', ')}; fall back to native Dev tools if any command fails or is absent`
    : 'fall back to native Dev tools if any command fails or is absent';
  return `Host CLI accelerators available: ${accelerators.join(', ')} (${guidance}).`;
}
