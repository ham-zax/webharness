#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function usage() {
  return [
    'Usage: webharness telemetry [options]',
    '',
    'Options:',
    '  --since <dur|all>   Time window: e.g. 1h, 24h, 7d, 30d, all (default: 7d)',
    '  --client <rule>     Filter by matched client rule (e.g. gemini, default, websession)',
    '  --repo <name>       Filter by inferred repo label (e.g. webharness, satori)',
    '  --issues            Show issues & friction focus only',
    '  --top <N>           Max rows per leaderboard (default: 8)',
    '  --json              Emit machine-readable JSON report',
    '  --file <path>       Telemetry JSONL path override',
    '  --help              Show this help',
    '',
  ].join('\n');
}

export function parseSinceMs(raw) {
  if (!raw || raw === 'all') return null;
  const match = /^(\d+)([mhdw])$/i.exec(String(raw).trim());
  if (!match) throw new Error(`invalid --since duration: ${raw} (expected e.g. 30m, 24h, 7d, 4w, or all)`);
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const mult = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 604_800_000;
  return n * mult;
}

export function parseArgs(argv) {
  const opts = {
    since: '7d',
    client: null,
    repo: null,
    issuesOnly: false,
    top: 8,
    json: false,
    file: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--issues') opts.issuesOnly = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--since') opts.since = argv[++i];
    else if (arg === '--client') opts.client = argv[++i];
    else if (arg === '--repo') opts.repo = argv[++i];
    else if (arg === '--file') opts.file = argv[++i];
    else if (arg === '--top') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('--top must be an integer from 1 to 100');
      opts.top = n;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

export function defaultTelemetryPath(env = process.env) {
  const stateDir = env.BRIDGE_STATE_DIR
    || env.MCP_BRIDGE_STATE_DIR
    || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'mcp-dev-bridge');
  return path.join(stateDir, 'logs', 'telemetry.jsonl');
}

export async function loadTelemetryRecords(baseFile, { sinceMs = null, nowMs = Date.now(), client = null, repo = null } = {}) {
  const candidates = [baseFile];
  for (let i = 1; i <= 5; i += 1) candidates.push(`${baseFile}.${i}`);
  const cutoff = sinceMs === null ? null : nowMs - sinceMs;
  const records = [];
  const filesRead = [];

  // Read oldest rotated files first so records stay roughly chronological.
  for (const file of candidates.reverse()) {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    filesRead.push(file);
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || typeof rec !== 'object') continue;
      if (cutoff !== null) {
        const tsMs = Date.parse(rec.ts);
        if (Number.isFinite(tsMs) && tsMs < cutoff) continue;
      }
      if (client && rec.client !== client) continue;
      if (repo && !(Array.isArray(rec.repos) && rec.repos.includes(repo))) continue;
      records.push(rec);
    }
  }
  return { records, filesRead };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function bump(map, key, updater) {
  map.set(key, updater(map.get(key) ?? null));
}

function formatNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function formatKB(bytes) {
  const b = Number(bytes || 0);
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

export function analyzeTelemetryRecords(records, { top = 8 } = {}) {
  const toolCalls = records.filter(r => r.rpc_method === 'tools/call');
  const sessions = new Set();
  const byClient = new Map();
  const byTool = new Map();
  const byRepo = new Map();
  const byErrorCode = new Map();
  const failingCommands = new Map();
  const byBin = new Map();
  const durations = [];
  const wakeTimes = [];
  const heaviestCalls = [];
  const slowOrDisconnected = [];

  let totalReqBytes = 0;
  let totalResBytes = 0;
  let totalReqTokens = 0;
  let totalResTokens = 0;
  let errorCalls = 0;
  let disconnectCalls = 0;
  let timedOutCalls = 0;
  let promotedJobs = 0;
  let truncatedCalls = 0;
  let schemaHints = 0;
  let blockedWrites = 0;
  let singleCalls = 0;
  let batchedCalls = 0;
  let totalBatchEntries = 0;

  let devSearchCalls = 0;
  let noisyDevSearches = 0;
  let satoriCalls = 0;
  let satoriAutoIndexing = 0;
  let writeBatchNudges = 0;
  let exploreSatoriNudges = 0;
  const nudgedSessions = new Set();
  const adoptedSessions = new Set();

  for (const r of toolCalls) {
    if (r.session) sessions.add(r.session);
    const reqB = Number(r.req_bytes || 0);
    const resB = Number(r.res_bytes || 0);
    const reqT = Number(r.est_req_tokens || Math.round(reqB / 4));
    const resT = Number(r.est_res_tokens || Math.round(resB / 4));
    totalReqBytes += reqB;
    totalResBytes += resB;
    totalReqTokens += reqT;
    totalResTokens += resT;
    if (typeof r.duration_ms === 'number') durations.push(r.duration_ms);
    if (typeof r.wake_ms === 'number' && r.wake_ms >= 50) wakeTimes.push(r.wake_ms);

    const isErr = Boolean(r.is_error || r.status >= 400 || r.outcome === 'disconnected');
    if (isErr) errorCalls += 1;
    if (r.outcome === 'disconnected') disconnectCalls += 1;
    if (r.timed_out) timedOutCalls += 1;
    if (r.promoted_job) promotedJobs += 1;
    if (r.truncated) truncatedCalls += 1;
    if (r.schema_hint_sent) schemaHints += 1;
    if (r.blocked_write) blockedWrites += 1;
    if (r.satori_auto_indexing) satoriAutoIndexing += 1;
    if (r.nudge_sent === 'write_batch') writeBatchNudges += 1;
    if (r.nudge_sent === 'explore_satori') {
      exploreSatoriNudges += 1;
      if (r.session) nudgedSessions.add(r.session);
    }

    const batchSize = Number(r.batch_size || 1);
    totalBatchEntries += batchSize;
    if (batchSize > 1) batchedCalls += 1;
    else singleCalls += 1;

    bump(byClient, r.client || 'default', cur => ({
      calls: (cur?.calls || 0) + 1,
      errors: (cur?.errors || 0) + (isErr ? 1 : 0),
      resTokens: (cur?.resTokens || 0) + resT,
    }));

    const routes = Array.isArray(r.routes) && r.routes.length > 0
      ? r.routes
      : [{ server: 'outer', tool: r.outer_tool || 'unknown' }];
    const perRouteResBytes = Math.round(resB / routes.length);
    const perRouteResTokens = Math.round(resT / routes.length);

    let callHasSatori = false;
    for (const rt of routes) {
      const key = `${rt.server}/${rt.tool}`;
      if (rt.server === 'satori') {
        satoriCalls += 1;
        callHasSatori = true;
      }
      if (rt.server === 'dev' && rt.tool === 'search') {
        devSearchCalls += 1;
        if (r.truncated || (typeof r.search_matches === 'number' && r.search_matches >= 25)) {
          noisyDevSearches += 1;
        }
      }
      if (rt.bin) {
        bump(byBin, rt.bin, cur => ({
          count: (cur?.count || 0) + 1,
          errors: (cur?.errors || 0) + (isErr ? 1 : 0),
        }));
      }
      if (isErr && rt.cmd) {
        const cmdKey = `${rt.repo ? `[${rt.repo}] ` : ''}${rt.cmd}`;
        bump(failingCommands, cmdKey, cur => ({
          count: (cur?.count || 0) + 1,
          exitCode: r.exit_code ?? cur?.exitCode ?? null,
          errorCode: r.error_code ?? cur?.errorCode ?? null,
        }));
      }
      bump(byTool, key, cur => ({
        calls: (cur?.calls || 0) + 1,
        errors: (cur?.errors || 0) + (isErr ? 1 : 0),
        resBytes: (cur?.resBytes || 0) + perRouteResBytes,
        resTokens: (cur?.resTokens || 0) + perRouteResTokens,
        totalMs: (cur?.totalMs || 0) + Math.round((r.duration_ms || 0) / routes.length),
      }));
    }

    if (callHasSatori && r.session && nudgedSessions.has(r.session)) {
      adoptedSessions.add(r.session);
    }

    const repos = Array.isArray(r.repos) && r.repos.length > 0 ? r.repos : ['(none)'];
    for (const repoName of repos) {
      bump(byRepo, repoName, cur => ({
        calls: (cur?.calls || 0) + 1,
        errors: (cur?.errors || 0) + (isErr ? 1 : 0),
        resTokens: (cur?.resTokens || 0) + Math.round(resT / repos.length),
      }));
    }

    if (isErr) {
      const code = r.error_code
        || (r.outcome === 'disconnected' ? 'CLIENT_DISCONNECTED' : null)
        || (r.timed_out ? 'TIMEOUT' : null)
        || (typeof r.exit_code === 'number' && r.exit_code !== 0 ? `EXIT_${r.exit_code}` : null)
        || (r.status >= 400 ? `HTTP_${r.status}` : 'TOOL_ERROR');
      const primaryRoute = routes.length === 1 ? `${routes[0].server}/${routes[0].tool}` : `${r.outer_tool}[${routes.length}]`;
      bump(byErrorCode, `${code} @ ${primaryRoute}`, cur => (cur || 0) + 1);
    }

    const label = routes.length === 1
      ? `${routes[0].server}/${routes[0].tool}${routes[0].cmd ? `: ${routes[0].cmd}` : routes[0].target ? `: ${routes[0].target}` : routes[0].query ? `: ${routes[0].query}` : ''}`
      : `${r.outer_tool}(${routes.length}x: ${[...new Set(routes.map(x => `${x.server}/${x.tool}`))].slice(0, 3).join(', ')})`;

    heaviestCalls.push({
      ts: r.ts,
      client: r.client,
      repo: r.repos?.[0] ?? null,
      label: label.slice(0, 110),
      resBytes: resB,
      resTokens: resT,
      durationMs: r.duration_ms || 0,
      truncated: Boolean(r.truncated),
    });

    if (r.outcome === 'disconnected' || (typeof r.budget_pct === 'number' && r.budget_pct >= 80)) {
      slowOrDisconnected.push({
        ts: r.ts,
        client: r.client,
        outcome: r.outcome,
        durationMs: r.duration_ms || 0,
        budgetPct: r.budget_pct ?? null,
        label: label.slice(0, 110),
      });
    }
  }

  durations.sort((a, b) => a - b);
  wakeTimes.sort((a, b) => a - b);

  return {
    summary: {
      total_records: records.length,
      tool_calls: toolCalls.length,
      sessions: sessions.size,
      total_req_bytes: totalReqBytes,
      total_res_bytes: totalResBytes,
      est_req_tokens: totalReqTokens,
      est_res_tokens: totalResTokens,
      error_calls: errorCalls,
      error_rate_pct: toolCalls.length ? +((errorCalls / toolCalls.length) * 100).toFixed(1) : 0,
      disconnects: disconnectCalls,
      timed_out: timedOutCalls,
      promoted_jobs: promotedJobs,
      truncated_calls: truncatedCalls,
      schema_hints: schemaHints,
      blocked_writes: blockedWrites,
      p50_ms: percentile(durations, 50),
      p95_ms: percentile(durations, 95),
      cold_wakes: wakeTimes.length,
      p50_wake_ms: percentile(wakeTimes, 50),
      batch_calls: batchedCalls,
      single_calls: singleCalls,
      avg_batch_size: toolCalls.length ? +(totalBatchEntries / toolCalls.length).toFixed(2) : 0,
    },
    code_intelligence: {
      satori_calls: satoriCalls,
      dev_search_calls: devSearchCalls,
      noisy_dev_searches: noisyDevSearches,
      satori_auto_indexing: satoriAutoIndexing,
      explore_satori_nudges: exploreSatoriNudges,
      write_batch_nudges: writeBatchNudges,
      nudged_sessions: nudgedSessions.size,
      post_nudge_satori_sessions: adoptedSessions.size,
    },
    clients: [...byClient.entries()].map(([name, v]) => ({ client: name, ...v })).sort((a, b) => b.calls - a.calls),
    top_tools_by_context: [...byTool.entries()]
      .map(([tool, v]) => ({ tool, calls: v.calls, errors: v.errors, resBytes: v.resBytes, resTokens: v.resTokens, avgMs: Math.round(v.totalMs / v.calls) }))
      .sort((a, b) => b.resTokens - a.resTokens)
      .slice(0, top),
    top_repos: [...byRepo.entries()]
      .map(([repo, v]) => ({ repo, ...v }))
      .sort((a, b) => b.resTokens - a.resTokens)
      .slice(0, top),
    top_heaviest_calls: heaviestCalls.sort((a, b) => b.resBytes - a.resBytes).slice(0, Math.min(top, 5)),
    top_errors: [...byErrorCode.entries()]
      .map(([key, count]) => ({ error: key, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, top),
    failing_commands: [...failingCommands.entries()]
      .map(([cmd, v]) => ({ cmd, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, top),
    slow_or_disconnected: slowOrDisconnected.sort((a, b) => b.durationMs - a.durationMs).slice(0, top),
    top_commands: [...byBin.entries()]
      .map(([bin, v]) => ({ bin, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, top),
  };
}

export function renderTelemetryReport(report, { issuesOnly = false, since = '7d', filePath = '' } = {}) {
  const s = report.summary;
  const ci = report.code_intelligence;
  const lines = [];
  lines.push(`== WebHarness Telemetry (window: ${since}${filePath ? ` · ${filePath}` : ''}) ==`);
  if (s.tool_calls === 0) {
    lines.push('No tool-call telemetry records found in the selected window.');
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `Calls: ${formatNum(s.tool_calls)} (${formatNum(s.sessions)} sessions) | Batching: ${s.batch_calls} batched / ${s.single_calls} single (avg ${s.avg_batch_size} ops/call)`,
    `Context: in ${formatKB(s.total_req_bytes)} (~${formatNum(s.est_req_tokens)} tok) | out ${formatKB(s.total_res_bytes)} (~${formatNum(s.est_res_tokens)} tok)`,
    `Latency: p50=${s.p50_ms}ms p95=${s.p95_ms}ms | Cold wakes: ${s.cold_wakes}${s.cold_wakes ? ` (p50=${s.p50_wake_ms}ms)` : ''}`,
    `Health: errors=${s.error_calls} (${s.error_rate_pct}%) | disconnects=${s.disconnects} | timeouts=${s.timed_out} | promoted=${s.promoted_jobs} | truncated=${s.truncated_calls} | schema_hints=${s.schema_hints} | blocked_writes=${s.blocked_writes}`,
  );

  lines.push('', '== Issues & Friction ==');
  if (report.top_errors.length === 0 && report.slow_or_disconnected.length === 0 && report.failing_commands.length === 0) {
    lines.push('  (no errors, disconnects, or near-budget calls recorded)');
  } else {
    if (report.top_errors.length > 0) {
      lines.push('  Errors:');
      for (const e of report.top_errors) lines.push(`    ${String(e.count).padStart(4)}x  ${e.error}`);
    }
    if (report.failing_commands.length > 0) {
      lines.push('  Failing commands:');
      for (const c of report.failing_commands) {
        const tag = c.exitCode !== null ? `exit=${c.exitCode}` : (c.errorCode || 'err');
        lines.push(`    ${String(c.count).padStart(4)}x  [${tag}] ${c.cmd}`);
      }
    }
    if (report.slow_or_disconnected.length > 0) {
      lines.push('  Disconnects / >=80% RPC budget:');
      for (const d of report.slow_or_disconnected) {
        lines.push(`    ${(d.durationMs / 1000).toFixed(1)}s (${d.outcome}${d.budgetPct !== null ? `, ${d.budgetPct}% budget` : ''}) [${d.client}] ${d.label}`);
      }
    }
  }

  lines.push('', '== Code Intelligence & Nudges ==');
  lines.push(`  satori=${ci.satori_calls} | dev/search=${ci.dev_search_calls} (noisy=${ci.noisy_dev_searches}) | auto_indexing=${ci.satori_auto_indexing}`);
  lines.push(`  nudges: explore_satori=${ci.explore_satori_nudges} (post-nudge adoption=${ci.post_nudge_satori_sessions}/${ci.nudged_sessions} sessions) | write_batch=${ci.write_batch_nudges}`);

  if (!issuesOnly) {
    lines.push('', '== Top Context Consumers (est. output tokens) ==');
    for (const t of report.top_tools_by_context) {
      lines.push(`  ${t.tool.padEnd(28)} ${String(t.calls).padStart(5)} calls | ~${formatNum(t.resTokens).padStart(9)} tok (${formatKB(t.resBytes)}) | avg ${t.avgMs}ms | err ${t.errors}`);
    }
    if (report.top_heaviest_calls.length > 0) {
      lines.push('  Heaviest single calls:');
      for (const h of report.top_heaviest_calls) {
        lines.push(`    ~${formatNum(h.resTokens).padStart(7)} tok (${formatKB(h.resBytes)}) ${h.truncated ? '[TRUNC] ' : ''}${h.label}`);
      }
    }
    if (report.top_repos.length > 0) {
      lines.push('', '== Top Repos ==');
      for (const r of report.top_repos) {
        lines.push(`  ${r.repo.padEnd(22)} ${String(r.calls).padStart(5)} calls | ~${formatNum(r.resTokens).padStart(9)} tok | err ${r.errors}`);
      }
    }
    if (report.top_commands.length > 0) {
      lines.push('', '== Top Commands ==');
      lines.push(`  ${report.top_commands.map(c => `${c.bin}(${c.count}${c.errors ? `/${c.errors}err` : ''})`).join(', ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    process.stdout.write(usage());
    return;
  }
  let sinceMs;
  try {
    sinceMs = parseSinceMs(opts.since);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const filePath = opts.file ? path.resolve(opts.file) : defaultTelemetryPath();
  const { records } = await loadTelemetryRecords(filePath, {
    sinceMs,
    client: opts.client,
    repo: opts.repo,
  });
  const report = analyzeTelemetryRecords(records, { top: opts.top });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ window: opts.since, file: filePath, ...report }, null, 2)}\n`);
  } else {
    process.stdout.write(renderTelemetryReport(report, { issuesOnly: opts.issuesOnly, since: opts.since, filePath }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
