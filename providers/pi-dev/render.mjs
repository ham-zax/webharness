function appendLines(output, annotations) {
  const base = output ?? '';
  if (annotations.length === 0) return base || 'Command completed.';
  if (!base) return annotations.join('\n');
  return `${base.endsWith('\n') ? base : `${base}\n`}${annotations.join('\n')}`;
}

export function renderBashText(result) {
  const annotations = [];
  if (result.truncated && result.full_output_path) {
    annotations.push(result.spool_truncated
      ? `[truncated · ${result.output_bytes} bytes total · retained output capped · file: ${result.full_output_path}]`
      : `[truncated · ${result.output_bytes} bytes total · full: ${result.full_output_path}]`);
  }
  let status;
  if (result.timed_out) {
    status = `timed out after ${result.timeout_seconds}s`;
  } else if (result.cancelled) {
    status = 'cancelled';
  } else if (result.exit_code === null) {
    status = 'terminated';
  } else {
    status = `exit ${result.exit_code}`;
  }
  if (Number.isFinite(result.duration_ms)) {
    status += ` · ${(result.duration_ms / 1000).toFixed(1)}s`;
  }
  annotations.push(`[${status}]`);
  return appendLines(result.output, annotations);
}

export function renderEditText(relativePath, diff) {
  return diff ? `${relativePath}\n${diff}` : `Updated ${relativePath}`;
}

/** Added and removed line counts from a Pi unified diff (+/- prefixed lines). */
export function countDiffLines(diff) {
  let added = 0;
  let removed = 0;
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

/** Quiet default for edit: confirms what changed and how much, without echoing the diff. */
export function renderEditSummary(relativePath, diff) {
  const { added, removed } = countDiffLines(diff);
  return `M ${relativePath} (+${added} -${removed})`;
}


export function renderEditPartial({ applied = [], failed = [], uncertain = [], unattempted = [], reason } = {}) {
  const lines = ['EDIT_PARTIAL'];
  if (applied.length) lines.push(`applied: ${applied.join(', ')}`);
  if (reason) lines.push(`reason: ${reason}`);
  for (const item of failed) lines.push(`failed: ${item.path}: ${item.message}`);
  for (const item of uncertain) lines.push(`uncertain: ${item.path}: ${item.message}`);
  if (unattempted.length) lines.push(`unattempted: ${unattempted.join(', ')}`);
  return lines.join('\n');
}

export function renderWriteText(relativePath, { replaced = false } = {}) {
  return `${replaced ? 'Replaced' : 'Created'} ${relativePath}`;
}

export function renderImportFileText(result) {
  return `Imported ${result.path}\nsize: ${result.size} bytes\nsha256: ${result.sha256}`;
}

export function renderReviewChangesText(result) {
  const { summary } = result;
  const lines = [
    `${summary.files} changed ${summary.files === 1 ? 'file' : 'files'} (+${summary.trackedAdditions} -${summary.trackedRemovals} tracked lines${summary.untracked ? `, ${summary.untracked} untracked` : ''})`,
  ];
  for (const file of result.files) {
    const rename = file.previousPath ? ` <- ${file.previousPath}` : '';
    const stats = file.status === '??' ? '' : ` +${file.additions} -${file.removals}`;
    lines.push(`${file.status} ${file.path}${rename}${stats}`);
  }
  if (result.patch) lines.push('', '--- patch ---', result.patch);
  if (result.patchTruncated) lines.push('', '[patch truncated; narrow with paths=[...]]');
  return lines.join('\n');
}

function fileOpLabel(operation) {
  return operation.kind === 'move'
    ? `move ${operation.path} -> ${operation.to}`
    : `delete ${operation.path}`;
}

export function renderFileOpsText(result) {
  return result.operations.map(operation => operation.kind === 'move'
    ? `R ${operation.path} -> ${operation.to}`
    : `D ${operation.path}`
  ).join('\n');
}

export function renderFileOpsPartial({ completed = [], failed = [], uncertain = [], unattempted = [], reason } = {}) {
  const lines = ['FILE_OPS_PARTIAL'];
  if (completed.length) lines.push(`completed: ${completed.map(fileOpLabel).join(', ')}`);
  if (reason) lines.push(`reason: ${reason}`);
  for (const item of failed) lines.push(`failed: ${fileOpLabel(item)}: ${item.message}`);
  for (const item of uncertain) {
    const sideEffects = item.sideEffects && Object.keys(item.sideEffects).length
      ? ` [${Object.entries(item.sideEffects).map(([key, value]) => `${key}=${value}`).join(', ')}]`
      : '';
    lines.push(`uncertain: ${fileOpLabel(item)}: ${item.message}${sideEffects}`);
  }
  if (unattempted.length) lines.push(`unattempted: ${unattempted.map(fileOpLabel).join(', ')}`);
  return lines.join('\n');
}
