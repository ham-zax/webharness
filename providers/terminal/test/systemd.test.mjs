import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

async function read(relative) {
  return readFile(path.join(repoRoot, relative), 'utf8');
}

test('tmux lifetime unit owns a foreground dedicated server without KillMode workaround', async () => {
  const unit = await read('systemd/wsl-agent-tmux.service.in');
  assert.match(unit, /^Type=simple$/m);
  assert.match(unit, /^ExecStart=@TMUX_BIN@ -D -L wsl-agent -f \/dev\/null$/m);
  assert.doesNotMatch(unit, /KillMode=process/);
  assert.doesNotMatch(unit, /^PartOf=/m);
  assert.doesNotMatch(unit, /^BindsTo=/m);
});

test('broker unit is a separate cgroup ordered after tmux without reverse lifetime coupling', async () => {
  const unit = await read('systemd/wsl-agent-terminal-broker.service.in');
  assert.match(unit, /^Requires=wsl-agent-tmux\.service$/m);
  assert.match(unit, /^After=wsl-agent-tmux\.service$/m);
  assert.match(unit, /^Environment=MCP_TERMINAL_SOCKET=%t\/wsl-agent-terminal\.sock$/m);
  assert.match(unit, /^Environment=MCP_TERMINAL_STATE_ROOT=@STATE_ROOT@$/m);
  assert.match(unit, /^Environment=MCP_TERMINAL_DEFAULT_CWD=@USER_HOME@$/m);
  assert.match(unit, /^ExecStart=@NODE_BIN@ @REPO_ROOT@\/providers\/terminal\/broker\.mjs$/m);
  assert.doesNotMatch(unit, /KillMode=process/);
  assert.doesNotMatch(unit, /^PartOf=/m);
  assert.doesNotMatch(unit, /^BindsTo=/m);
});

test('terminal installer targets only the two independent wsl-agent units', async () => {
  const script = await read('scripts/install-terminal-broker-user.sh');
  assert.match(script, /wsl-agent-tmux\.service/);
  assert.match(script, /wsl-agent-terminal-broker\.service/);
  assert.doesNotMatch(script, /systemctl[^\n]*(mcp-dev-bridge|cloudflared|1mcp)/i);
});
