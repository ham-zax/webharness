#!/usr/bin/env node
import { readFile, stat, unlink } from 'node:fs/promises';

const [gatePath, commandPath] = process.argv.slice(2);
if (!gatePath || !commandPath) process.exit(64);

const deadline = Date.now() + 30000;
while (true) {
  try {
    await stat(gatePath);
    break;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (Date.now() >= deadline) process.exit(125);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let command = '';
try {
  command = await readFile(commandPath, 'utf8');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await Promise.allSettled([unlink(gatePath), unlink(commandPath)]);

const shell = process.env.SHELL || '/bin/bash';
if (typeof process.execve !== 'function') {
  throw new Error('Node.js process.execve is required for durable terminal pane handoff');
}
if (command.length > 0) {
  process.execve(shell, [shell, '-lc', command], process.env);
} else {
  process.execve(shell, [shell], process.env);
}
