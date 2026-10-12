#!/usr/bin/env node
// Ratchet gate for deterministic performance metrics.
//
//   node ratchet.mjs check  <baseline.json> <metrics.json> [--tolerance 0.005] [--markdown FILE]
//   node ratchet.mjs update <baseline.json> <metrics.json> [--tolerance 0.005] [--markdown FILE]
//
// baseline.json: { "<metric>": { "ceiling": <number>, "unit": "instructions" } , ... }
// metrics.json:  { "<metric>": <number>, ... }   (lower is better for every metric)
//
// check  fails (exit 1) when any metric exceeds ceiling * (1 + tolerance), or when a
//        baselined metric is missing from metrics.json.
// update runs check first, then lowers each ceiling to the measured value when it
//        improved. It never raises a ceiling: a deliberate regression is a reviewed
//        edit to baseline.json, not a flag.
// New metrics in metrics.json are reported and, on update, added at their value.
// --markdown appends a results table to FILE (e.g. "$GITHUB_STEP_SUMMARY", or a file
//        posted as a PR comment) so coding and review agents see regressions too.

import fs from 'node:fs';

const [mode, baselinePath, metricsPath, ...rest] = process.argv.slice(2);
if (!['check', 'update'].includes(mode) || !baselinePath || !metricsPath) {
    console.error('usage: ratchet.mjs check|update <baseline.json> <metrics.json> [--tolerance 0.005] [--markdown FILE]');
    process.exit(2);
}
const option = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
};
const tolerance = Number(option('--tolerance') ?? 0.005);
if (!Number.isFinite(tolerance) || tolerance < 0) {
    console.error('--tolerance must be a non-negative number');
    process.exit(2);
}
const markdownPath = option('--markdown');
if (rest.includes('--markdown') && (!markdownPath || markdownPath.startsWith('--'))) {
    console.error('--markdown needs a file path');
    process.exit(2);
}

const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : {};
const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
// A non-numeric ceiling makes every comparison false, which would read as OK.
const malformed = Object.keys(baseline).filter((name) => {
    const ceiling = baseline[name]?.ceiling;
    return typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling < 0;
});
if (malformed.length) {
    console.error(`baseline entries need a non-negative numeric "ceiling": ${malformed.join(', ')}`);
    process.exit(2);
}

let failed = false;
const lines = [];
const rows = [];
for (const name of Object.keys(baseline).sort()) {
    const { ceiling } = baseline[name];
    const value = metrics[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        failed = true;
        lines.push(`MISSING   ${name}`);
        rows.push(['MISSING', name, '', ceiling, '']);
        continue;
    }
    const delta = ceiling === 0 ? (value === 0 ? 0 : Infinity) : ((value - ceiling) / ceiling) * 100;
    const pct = Number.isFinite(delta) ? `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%` : 'from 0';
    if (value > ceiling * (1 + tolerance)) {
        failed = true;
        lines.push(`REGRESSED ${name}: ${value} > ceiling ${ceiling} (${pct})`);
        rows.push(['REGRESSED', name, value, ceiling, pct]);
    } else if (value < ceiling) {
        lines.push(`IMPROVED  ${name}: ${value} < ceiling ${ceiling} (${pct})`);
        rows.push(['IMPROVED', name, value, ceiling, pct]);
        if (mode === 'update') baseline[name].ceiling = value;
    } else {
        lines.push(`OK        ${name}: ${value} (ceiling ${ceiling}, ${pct})`);
        rows.push(['OK', name, value, ceiling, pct]);
    }
}
for (const name of Object.keys(metrics).sort()) {
    if (name in baseline) continue;
    lines.push(`NEW       ${name}: ${metrics[name]}`);
    rows.push(['NEW', name, metrics[name], '', '']);
    if (mode === 'update') baseline[name] = { ceiling: metrics[name] };
}
console.log(lines.join('\n'));

if (markdownPath) {
    // Failures first, so a reviewer sees them without scrolling.
    const order = ['REGRESSED', 'MISSING', 'IMPROVED', 'NEW', 'OK'];
    rows.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    const table = [
        `### Perf ratchet: ${failed ? 'FAIL' : 'PASS'} (tolerance ${(tolerance * 100).toFixed(2)}%)`,
        '',
        '| Status | Metric | Value | Ceiling | Change |',
        '|---|---|---:|---:|---:|',
        ...rows.map((r) => `| ${r.map((c) => String(c).replaceAll('|', '\\|')).join(' | ')} |`),
        '',
    ];
    fs.appendFileSync(markdownPath, `${table.join('\n')}\n`);
}

if (failed) {
    console.error('ratchet: FAIL');
    process.exit(1);
}
if (mode === 'update') {
    const sorted = Object.fromEntries(Object.keys(baseline).sort().map((k) => [k, baseline[k]]));
    fs.writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`ratchet: baseline written to ${baselinePath}`);
}
