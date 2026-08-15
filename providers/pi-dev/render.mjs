function appendLines(output, annotations) {
  const base = output ?? '';
  if (annotations.length === 0) return base || 'Command completed.';
  if (!base) return annotations.join('\n');
  return `${base.endsWith('\n') ? base : `${base}\n`}${annotations.join('\n')}`;
}

export function renderBashText(result) {
  const annotations = [];
  if (result.truncated && result.full_output_path) {
    annotations.push(`[truncated · full: ${result.full_output_path}]`);
  }
  if (result.timed_out) {
    annotations.push(`[timed out after ${result.timeout_seconds}s]`);
  } else if (result.cancelled) {
    annotations.push('[cancelled]');
  } else if (result.exit_code === null) {
    annotations.push('[terminated]');
  } else if (result.exit_code !== 0) {
    annotations.push(`[exit ${result.exit_code}]`);
  }
  return appendLines(result.output, annotations);
}

export function renderEditText(relativePath, diff) {
  return diff ? `${relativePath}\n${diff}` : `Updated ${relativePath}`;
}

export function renderWriteText(relativePath) {
  return `Created ${relativePath}`;
}
