#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { readTraceControl, startTrace, stopTrace, traceLogPath } from '../lib/bridge/http-wire-trace.mjs';

const root = process.env.BRIDGE_STATE_DIR || process.env.MCP_BRIDGE_STATE_DIR
  || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'mcp-dev-bridge');
const [action = 'status', duration] = process.argv.slice(2);
try {
  if (action === 'start') startTrace(root, duration === undefined ? 1800 : Number(duration));
  else if (action === 'stop') stopTrace(root);
  else if (action !== 'status') throw new Error('Usage: node scripts/http-trace.mjs start [seconds] | stop | status');
  const control = readTraceControl(root);
  console.log(`HTTP trace: ${control ? 'armed' : 'off'}`);
  if (control) {
    console.log(`capture: ${control.id}`);
    console.log(`expires: ${new Date(control.expires_ms).toISOString()}`);
  }
  console.log(`log: ${traceLogPath(root)}`);
  console.log('Auth payloads are omitted. Tool arguments and results may contain private content.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
