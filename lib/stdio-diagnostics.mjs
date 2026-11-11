const MAX_STDIO_ERROR_CHARS = 512;

export function formatStdioDiagnostic(providerName, error) {
  const raw = error instanceof Error
    ? (typeof error.message === 'string' && error.message.length > 0 ? error.message : error.name)
    : String(error ?? '');
  const collapsed = raw.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const bounded = collapsed.length > MAX_STDIO_ERROR_CHARS
    ? `${collapsed.slice(0, MAX_STDIO_ERROR_CHARS - 3)}...`
    : (collapsed || 'unknown stdio error');
  return `${providerName}: stdio error: ${bounded}\n`;
}

export function createStdioErrorReporter(providerName, stream = process.stderr) {
  if (typeof providerName !== 'string' || providerName.trim().length === 0) {
    throw new TypeError('providerName must be a non-empty string');
  }
  const label = providerName.trim();
  return error => {
    try {
      stream.write(formatStdioDiagnostic(label, error));
    } catch {
      // Diagnostic reporting must never disrupt the JSON-RPC stdio transport.
    }
  };
}
