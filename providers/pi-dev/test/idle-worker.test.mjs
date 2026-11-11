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
  const client = new Client({ name: 'sigterm-test', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { pin: '2026-07-28' } });
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
