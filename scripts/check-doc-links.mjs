#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listed = execFileSync(
  'git',
  ['ls-files', '-co', '--exclude-standard', '--', '*.md'],
  { cwd: root, encoding: 'utf8' },
).trim();
const files = listed
  ? listed.split('\n').filter(file => file && !file.split('/').includes('node_modules'))
  : [];

function externalOrAnchor(target) {
  return target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function cleanTarget(raw) {
  let target = raw.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  target = target.replace(/\s+["'][^"']*["']\s*$/, '');
  target = target.split('#', 1)[0].split('?', 1)[0];
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function markdownOutsideFences(text) {
  const kept = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(```+|~~~+)/);
    if (match) {
      if (!fence) fence = match[1][0];
      else if (match[1][0] === fence) fence = null;
      continue;
    }
    if (!fence) kept.push(line);
  }
  return kept.join('\n');
}

function targetsFrom(text) {
  const targets = [];
  const inline = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of text.matchAll(inline)) targets.push(match[1]);

  const reference = /^\s*\[[^\]]+\]:\s*(\S+)/gm;
  for (const match of text.matchAll(reference)) targets.push(match[1]);
  return targets;
}

const broken = [];
for (const relativeFile of files) {
  const absoluteFile = path.join(root, relativeFile);
  const text = markdownOutsideFences(fs.readFileSync(absoluteFile, 'utf8'));
  for (const rawTarget of targetsFrom(text)) {
    const target = cleanTarget(rawTarget);
    if (!target || externalOrAnchor(target)) continue;

    const resolved = target.startsWith('/')
      ? path.join(root, target.slice(1))
      : path.resolve(path.dirname(absoluteFile), target);

    if (!fs.existsSync(resolved)) broken.push(`${relativeFile}: ${rawTarget}`);
  }
}

if (broken.length > 0) {
  for (const item of broken) console.error(`broken documentation link: ${item}`);
  process.exit(1);
}

console.log(`documentation links OK (${files.length} Markdown files)`);
