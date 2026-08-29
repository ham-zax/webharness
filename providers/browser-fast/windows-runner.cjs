const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const [executable, rawArgs, rawMaxBytes] = process.argv.slice(2);
const args = JSON.parse(rawArgs);
const maxBytes = Number(rawMaxBytes);
const input = fs.readFileSync(0);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-browser-fast-'));
const stdoutPath = path.join(tempDir, 'stdout.txt');
const stderrPath = path.join(tempDir, 'stderr.txt');
const stdoutFd = fs.openSync(stdoutPath, 'w');
const stderrFd = fs.openSync(stderrPath, 'w');

function readBounded(filePath, stream) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) throw new Error(`${stream} exceeded ${maxBytes} bytes`);
  return fs.readFileSync(filePath, 'utf8').trim();
}

function finish(payload, exitCode = 0) {
  try {
    fs.closeSync(stdoutFd);
  } catch {}
  try {
    fs.closeSync(stderrFd);
  } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.stdout.write(JSON.stringify(payload), () => process.exit(exitCode));
}

const child = spawn(executable, args, {
  stdio: ['pipe', stdoutFd, stderrFd],
  windowsHide: true
});
let settled = false;
child.once('error', error => {
  if (settled) return;
  settled = true;
  finish({ error: error.message }, 125);
});
child.once('exit', (code, signal) => {
  if (settled) return;
  settled = true;
  try {
    finish({
      code: code ?? -1,
      signal,
      stdout: readBounded(stdoutPath, 'stdout'),
      stderr: readBounded(stderrPath, 'stderr')
    });
  } catch (error) {
    finish({ error: error instanceof Error ? error.message : String(error) }, 125);
  }
});
child.stdin.on('error', () => {});
child.stdin.end(input);
