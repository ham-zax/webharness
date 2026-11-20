import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawn } from 'node:child_process';
import { IdleExecutionWorker } from '../idle-worker.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, idleMs = 50) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-worker-'));
  const source = `import fs from 'node:fs';
import { serveExecutionWorker } from ${JSON.stringify(new URL('../idle-worker.mjs', import.meta.url).href)};
serveExecutionWorker(new Map([
 ['echo', async args => ({content: [{type: 'image', data: 'aGVsbG8=', mimeType: 'image/png'}], structuredContent: { args, pid: process.pid }})],
 ['error', async () => { throw new Error('execution failed'); }],
 ['crash', async () => { fs.appendFileSync(${JSON.stringify(path.join(root,'crash.log'))}, 'called\\n'); process.exit(7); }],
 ['delay', async (args, {signal}) => { await new Promise(resolve => { const timer = setTimeout(resolve, args.ms); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, {once:true}); }); return {content: [], structuredContent: {aborted:signal.aborted, pid:process.pid}}; }],
]));`;
  const serverPath = path.join(root, 'worker.mjs');
  await fs.writeFile(serverPath, source);
  const worker = new IdleExecutionWorker({ serverPath, idleMs });
  worker.crashMarker = path.join(root, 'crash.log');
  t.after(async () => { await worker.close(); await fs.rm(root, {recursive:true, force:true}); });
  return worker;
}

test('worker is cold until execution; concurrent calls share startup and preserve rich results', async t => {
  const worker = await fixture(t);
  assert.equal(worker.child, null);
  const results = await Promise.all([worker.call('echo', {a:1}), worker.call('echo', {b:2})]);
  assert.equal(results[0].structuredContent.pid, results[1].structuredContent.pid);
  assert.deepEqual(results[0].structuredContent.args, {a:1});
  assert.equal(results[0].content[0].type, 'image');
});

test('idle worker exits and next call starts a new process; errors are not replayed', async t => {
  const worker = await fixture(t);
  const first = await worker.call('echo', {});
  await assert.rejects(worker.call('error', {}), /execution failed/);
  await sleep(200);
  assert.equal(worker.child, null);
  const next = await worker.call('echo', {});
  assert.notEqual(first.structuredContent.pid, next.structuredContent.pid);
});

test('worker death fails the affected call once without replaying side effects', async t => {
  const worker = await fixture(t);
  await assert.rejects(worker.call('crash', {}), /exited.*not replayed/);
  assert.equal(await fs.readFile(worker.crashMarker, 'utf8'), 'called\n');
  const next = await worker.call('echo', { restarted: true });
  assert.deepEqual(next.structuredContent.args, { restarted: true });
  assert.equal(await fs.readFile(worker.crashMarker, 'utf8'), 'called\n');
});

test('in-flight calls prevent eviction; cancellation reaches the child', async t => {
  const worker = await fixture(t);
  const controller = new AbortController();
  const pending = worker.call('delay', {ms:2000}, controller.signal);
  await sleep(150);
  assert.ok(worker.child);
  controller.abort();
  assert.equal((await pending).structuredContent.aborted, true);
  await sleep(200);
  assert.equal(worker.child, null);
});

test('disabled idle eviction retains worker; close aborts active calls and reaps child', async t => {
  const worker = await fixture(t, 0);
  const first = await worker.call('echo', {});
  await sleep(150);
  assert.equal(worker.child.pid, first.structuredContent.pid);
  const pending = worker.call('delay', {ms:2000});
  await sleep(30);
  await worker.close();
  assert.equal((await pending).structuredContent.aborted, true);
  assert.equal(worker.child, null);
  await assert.rejects(worker.call('echo', {}), /closed/);
});

test('real MCP discovery stays cold and retains schema metadata and owner instructions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-cold-'));
  const context = path.join(root, 'owner.md');
  await fs.writeFile(context, 'owner instructions');
  const transport = new StdioClientTransport({command:process.execPath, args:[new URL('../server.mjs', import.meta.url).pathname], env:{...process.env, MCP_DEV_SHELL_MODE:'unrestricted', MCP_DEV_PATH_MODE:'user', MCP_DEV_DEFAULT_CWD:root, MCP_DEV_STATE_DIR:root, MCP_DEV_TERMINAL_SOCKET:path.join(root,'broker.sock'), MCP_OWNER_CONTEXT_FILE:context, MCP_DEV_WORKER_IDLE_MS:'60'}, stderr:'pipe'});
  const client = new Client({name:'cold-test',version:'1'});
  t.after(async () => { await client.close(); await fs.rm(root,{recursive:true,force:true}); });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.find(tool => tool.name === 'import_file')._meta, {'openai/fileParams':['file']});
  const published = client.getInstructions();
  assert.ok(published.endsWith('\n\nowner instructions'));
  assert.match(published, /Dev file access policy/);
  assert.equal((await fs.readFile(`/proc/${transport.pid}/task/${transport.pid}/children`, 'utf8')).trim(), '');
  await fs.writeFile(path.join(root,'hello.txt'),'hello');
  const result = await client.callTool({name:'read',arguments:{path:'hello.txt'}});
  assert.equal(result.content[0].text,'hello');
  const workerPid = Number((await fs.readFile(`/proc/${transport.pid}/task/${transport.pid}/children`, 'utf8')).trim());
  assert.ok(workerPid > 0);
  await sleep(220);
  assert.equal((await fs.readFile(`/proc/${transport.pid}/task/${transport.pid}/children`, 'utf8')).trim(), '');
  const pending = await client.callTool({name:'wait', arguments:{name:'durable',condition:{kind:'timer',after_seconds:1},hold_seconds:0}});
  assert.match(pending.content[0].text,/^pending durable /);
  await client.callTool({name:'read',arguments:{path:'hello.txt'}});
  await sleep(220);
  const matched = await client.callTool({name:'wait', arguments:{name:'durable',hold_seconds:0}});
  assert.match(matched.content[0].text,/^matched durable/);
  await client.callTool({name:'read',arguments:{path:'hello.txt'}});
  const closingPid = Number((await fs.readFile(`/proc/${transport.pid}/task/${transport.pid}/children`, 'utf8')).trim());
  await client.close();
  assert.throws(() => process.kill(closingPid,0), error => error.code === 'ESRCH');
});

test('MCP_DEV_PREWARM_WORKER=1 pre-warms the execution worker before the first tool call', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-prewarm-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../server.mjs', import.meta.url).pathname],
    env: {
      ...process.env,
      MCP_DEV_SHELL_MODE: 'unrestricted',
      MCP_DEV_PATH_MODE: 'user',
      MCP_DEV_DEFAULT_CWD: root,
      MCP_DEV_STATE_DIR: root,
      MCP_DEV_TERMINAL_SOCKET: path.join(root, 'broker.sock'),
      MCP_DEV_WORKER_IDLE_MS: '60000',
      MCP_DEV_PREWARM_WORKER: '1',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'prewarm-test', version: '1' });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  await client.connect(transport);
  let childPid = 0;
  for (let i = 0; i < 40; i += 1) {
    const raw = (await fs.readFile(`/proc/${transport.pid}/task/${transport.pid}/children`, 'utf8')).trim();
    if (raw) { childPid = Number(raw.split(/\s+/)[0]); break; }
    await sleep(50);
  }
  assert.ok(childPid > 0, 'pre-warmed worker child should exist before any tool call');
});

test('MCP_DEV_PREWARM_WORKER=1 idles out after MCP_DEV_WORKER_IDLE_MS when no tool calls arrive', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-prewarm-idle-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../server.mjs', import.meta.url).pathname],
    env: {
      ...process.env,
      MCP_DEV_SHELL_MODE: 'unrestricted',
      MCP_DEV_PATH_MODE: 'user',
      MCP_DEV_DEFAULT_CWD: root,
      MCP_DEV_STATE_DIR: root,
      MCP_DEV_TERMINAL_SOCKET: path.join(root, 'broker.sock'),
      MCP_DEV_WORKER_IDLE_MS: '400',
      MCP_DEV_PREWARM_WORKER: '1',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'prewarm-idle-test', version: '1' });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  await client.connect(transport);
  let childPid = 0;
  for (let i = 0; i < 40; i += 1) {
    const raw = (await fs.readFile(`/proc/${transport.pid}/task/${transport.pid}/children`, 'utf8')).trim();
    if (raw) { childPid = Number(raw.split(/\s+/)[0]); break; }
    await sleep(50);
  }
  assert.ok(childPid > 0, 'pre-warmed worker child should start');
  let exited = false;
  for (let i = 0; i < 60; i += 1) {
    try { process.kill(childPid, 0); }
    catch (error) { if (error.code === 'ESRCH') { exited = true; break; } }
    await sleep(50);
  }
  assert.equal(exited, true, 'pre-warmed idle worker should exit after MCP_DEV_WORKER_IDLE_MS');
});

for (const tool of ['exec', 'bash']) test(`real ${tool} shutdown aborts and reaps detached command process groups`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-tree-'));
  const worker = new IdleExecutionWorker({serverPath:new URL('../server.mjs',import.meta.url).pathname, env:{...process.env,MCP_DEV_SHELL_MODE:'unrestricted',MCP_DEV_PATH_MODE:'workspace',MCP_DEV_WORKSPACE_ROOT:root,MCP_DEV_STATE_DIR:root}});
  t.after(async () => { await worker.close(); await fs.rm(root,{recursive:true,force:true}); });
  const pidFile = path.join(root,'command.pid');
  const command = 'echo $$ > command.pid; sleep 30';
  const pending = worker.call(tool, tool === 'exec' ? {argv:['bash','-c',command]} : {command});
  let commandPid;
  for (let attempt=0;attempt<200;attempt++) {
    try { commandPid=Number(await fs.readFile(pidFile,'utf8')); break; } catch (error) { if (error.code!=='ENOENT') throw error; }
    await sleep(25);
  }
  assert.ok(commandPid>0,'command started');
  await worker.close();
  await pending;
  assert.throws(() => process.kill(commandPid,0), error=>error.code==='ESRCH');
});


test('invalid idle settings fail before MCP discovery instead of silently disabling eviction', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-idle-env-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  for (const value of ['', '-1', 'invalid', '2147483648']) {
    const child=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname],{env:{...process.env,MCP_DEV_SHELL_MODE:'allowlist',MCP_DEV_PATH_MODE:'workspace',MCP_DEV_WORKSPACE_ROOT:root,MCP_DEV_STATE_DIR:root,MCP_DEV_WORKER_IDLE_MS:value},stdio:['ignore','ignore','pipe']});
    let stderr='';
    child.stderr.on('data', chunk=>{stderr+=chunk;});
    const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
    assert.equal(code,2);
    assert.match(stderr,/MCP_DEV_WORKER_IDLE_MS must be an integer/);
  }
});

test('SIGTERM on pi-dev stdio server exits 0 and reaps execution worker and active child commands', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-sigterm-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const serverPath = new URL('../server.mjs', import.meta.url).pathname;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      MCP_DEV_SHELL_MODE: 'unrestricted',
      MCP_DEV_PATH_MODE: 'workspace',
      MCP_DEV_WORKSPACE_ROOT: root,
      MCP_DEV_STATE_DIR: root,
      MCP_DEV_WORKER_IDLE_MS: '60000',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'sigterm-test', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(transport);
  const serverPid = transport.pid;
  assert.ok(serverPid > 0);

  const cmdPidFile = path.join(root, 'cmd.pid');
  const pending = client.callTool({ name: 'bash', arguments: { command: 'echo $$ > cmd.pid; sleep 30' } }).catch(() => {});
  let cmdPid = 0;
  for (let i = 0; i < 200; i += 1) {
    try {
      cmdPid = Number((await fs.readFile(cmdPidFile, 'utf8')).trim());
      if (cmdPid > 0) break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await sleep(25);
  }
  assert.ok(cmdPid > 0, 'child command started inside worker');
  const workerPid = Number((await fs.readFile(`/proc/${serverPid}/task/${serverPid}/children`, 'utf8')).trim());
  assert.ok(workerPid > 0, 'execution worker child is running');

  process.kill(serverPid, 'SIGTERM');
  await pending;
  for (let i = 0; i < 100; i += 1) {
    let alive = false;
    for (const pid of [serverPid, workerPid, cmdPid]) {
      try { process.kill(pid, 0); alive = true; } catch {}
    }
    if (!alive) break;
    await sleep(30);
  }
  for (const [label, pid] of [['server', serverPid], ['worker', workerPid], ['command', cmdPid]]) {
    assert.throws(() => process.kill(pid, 0), err => err.code === 'ESRCH', `${label} (${pid}) was not reaped`);
  }
  await transport.close().catch(() => {});
});

test('closing IdleExecutionWorker during startup before ready immediately terminates and reaps the starting child', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-abort-startup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pidFile = path.join(root, 'starting.pid');
  const slowWorkerPath = path.join(root, 'slow-worker.mjs');
  await fs.writeFile(
    slowWorkerPath,
    `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => {}, 30000);
`,
    'utf8',
  );
  const worker = new IdleExecutionWorker({ serverPath: slowWorkerPath, idleMs: 60_000 });
  const callPromise = worker.call('echo', {});
  let childPid = 0;
  for (let i = 0; i < 200; i += 1) {
    try {
      childPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
      if (childPid > 0) break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await sleep(20);
  }
  assert.ok(childPid > 0, 'slow-starting worker spawned');
  const closeStart = Date.now();
  await worker.close();
  const elapsedMs = Date.now() - closeStart;
  await assert.rejects(callPromise, /exited|closed/i);
  assert.ok(elapsedMs < 2000, `close() during startup must not stall waiting for ready (took ${elapsedMs}ms)`);
  assert.throws(() => process.kill(childPid, 0), err => err.code === 'ESRCH');
});

test('IdleExecutionWorker clears failed spawn handle and recovers cleanly on next call', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-spawn-err-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const badPath = path.join(root, 'missing-worker.mjs');
  const worker = new IdleExecutionWorker({ serverPath: badPath, idleMs: 60_000 });
  await assert.rejects(() => worker.call('echo', {}), /exited|ENOENT/i);
  assert.equal(worker.child, null, 'failed worker handle must be cleared so subsequent calls can respawn');
  await worker.stop();

  const goodPath = path.join(root, 'good-worker.mjs');
  await fs.writeFile(goodPath, `
process.on('message', m => {
  if (m.type === 'shutdown') process.exit(0);
  if (m.type === 'call') process.send({ type: 'result', id: m.id, result: { ok: true } });
});
process.send({ type: 'ready' });
`, 'utf8');
  worker.serverPath = goodPath;
  const res = await worker.call('echo', {});
  assert.deepEqual(res, { ok: true });
  await worker.close();
});

test('IdleExecutionWorker keeps promoted job supervised across short idleMs and releases runtime lease on completion', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-promoted-idle-'));
  const leaseDir = path.join(root, 'leases');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worker = new IdleExecutionWorker({
    serverPath: new URL('../server.mjs', import.meta.url).pathname,
    idleMs: 40,
    env: {
      ...process.env,
      MCP_DEV_SHELL_MODE: 'unrestricted',
      MCP_DEV_PATH_MODE: 'workspace',
      MCP_DEV_WORKSPACE_ROOT: root,
      MCP_DEV_STATE_DIR: root,
      MCP_LIFECYCLE_LEASE_DIR: leaseDir,
    },
  });
  t.after(() => worker.close());

  const res = await worker.call('bash', {
    command: 'sleep 0.5 && echo finished-after-idle',
    softTimeoutSeconds: 0.2,
    timeout_seconds: 5,
  });
  assert.match(res.content[0].text, /promoted to job (\S+)/);
  const jobId = res.content[0].text.match(/promoted to job (\S+)/)[1];
  const exitPath = path.join(root, 'jobs', `${jobId}.exit`);
  const logPath = path.join(root, 'jobs', `${jobId}.log`);

  const leasesDuring = (await fs.readdir(leaseDir)).filter(f => f.endsWith('.json'));
  assert.equal(leasesDuring.length, 1, 'active runtime lease must pin outer provider while promoted job runs');

  // Wait longer than idleMs (40ms) for the job to finish naturally.
  for (let i = 0; i < 100; i += 1) {
    if (await fs.access(exitPath).then(() => true, () => false)) break;
    await sleep(30);
  }
  assert.equal(await fs.readFile(exitPath, 'utf8'), '0\n');
  assert.match(await fs.readFile(logPath, 'utf8'), /finished-after-idle/);

  // Lease must be released after completion.
  for (let i = 0; i < 40; i += 1) {
    const remaining = (await fs.readdir(leaseDir)).filter(f => f.endsWith('.json'));
    if (remaining.length === 0) break;
    await sleep(20);
  }
  assert.deepEqual((await fs.readdir(leaseDir)).filter(f => f.endsWith('.json')), []);
});

test('IdleExecutionWorker explicit close() terminates promoted job with exit evidence instead of orphaning', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-promoted-close-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worker = new IdleExecutionWorker({
    serverPath: new URL('../server.mjs', import.meta.url).pathname,
    idleMs: 60_000,
    env: {
      ...process.env,
      MCP_DEV_SHELL_MODE: 'unrestricted',
      MCP_DEV_PATH_MODE: 'workspace',
      MCP_DEV_WORKSPACE_ROOT: root,
      MCP_DEV_STATE_DIR: root,
    },
  });
  t.after(() => worker.close());

  const res = await worker.call('bash', {
    command: 'sleep 30',
    softTimeoutSeconds: 0.2,
    timeout_seconds: 30,
  });
  const jobId = res.content[0].text.match(/promoted to job (\S+)/)[1];
  const exitPath = path.join(root, 'jobs', `${jobId}.exit`);

  await worker.close();
  assert.equal(await fs.access(exitPath).then(() => true, () => false), true, 'explicit shutdown must write exit marker for promoted job');
});
