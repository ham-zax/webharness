import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveUserPath } from './boundary.mjs';
import { withMutationPath } from './mutation-coordinator.mjs';

const TRUSTED_FILE_HOSTS = new Set(['files.oaiusercontent.com']);
const REGIONAL_OPENAI_BLOB_HOST = /^oaisdmntpr[a-z0-9]+\.blob\.core\.windows\.net$/u;
const REDIRECT_LIMIT = 3;
const DOWNLOAD_TIMEOUT_MS = 30_000;

function importError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function trustedFileHost(hostname) {
  return TRUSTED_FILE_HOSTS.has(hostname) || REGIONAL_OPENAI_BLOB_HOST.test(hostname);
}

function validatedDownloadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw importError('IMPORT_FILE_SOURCE_INVALID', 'ChatGPT file download URL is invalid');
  }
  if (
    url.protocol !== 'https:'
    || !trustedFileHost(url.hostname)
    || (url.port !== '' && url.port !== '443')
    || url.username
    || url.password
  ) {
    throw importError('IMPORT_FILE_SOURCE_INVALID', 'ChatGPT file download URL is not from a trusted OpenAI file host');
  }
  return url.toString();
}

function normalizedReference(file) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    throw importError('IMPORT_FILE_REFERENCE_INVALID', 'file must be a native ChatGPT file value');
  }
  if (typeof file.download_url !== 'string' || typeof file.file_id !== 'string' || file.file_id.length === 0) {
    throw importError('IMPORT_FILE_REFERENCE_INVALID', 'ChatGPT file reference is malformed');
  }
  if (file.size !== undefined && file.size !== null && (!Number.isSafeInteger(file.size) || file.size < 0)) {
    throw importError('IMPORT_FILE_REFERENCE_INVALID', 'ChatGPT file size metadata is invalid');
  }
  return {
    downloadUrl: validatedDownloadUrl(file.download_url),
    size: file.size ?? undefined,
  };
}

function redirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function openSource(reference, signal) {
  let url = reference.downloadUrl;
  for (let redirects = 0; redirects <= REDIRECT_LIMIT; redirects += 1) {
    let response;
    try {
      const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      response = await fetch(url, { redirect: 'manual', signal: combined });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw importError('IMPORT_FILE_DOWNLOAD_FAILED', 'ChatGPT file could not be downloaded');
    }

    if (!redirectStatus(response.status)) {
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw importError('IMPORT_FILE_DOWNLOAD_FAILED', 'ChatGPT file download did not return file content');
      }
      return response;
    }

    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects === REDIRECT_LIMIT) {
      throw importError('IMPORT_FILE_DOWNLOAD_FAILED', 'ChatGPT file download returned an invalid redirect');
    }
    url = validatedDownloadUrl(new URL(location, url).toString());
  }
  throw importError('IMPORT_FILE_DOWNLOAD_FAILED', 'ChatGPT file download exceeded the redirect limit');
}

async function resolveDestination(defaultCwd, value) {
  const unresolved = await resolveUserPath(defaultCwd, value, { mustExist: false });
  const name = path.basename(unresolved);
  if (!name || name === '.' || name === '..') {
    throw importError('IMPORT_FILE_DESTINATION_INVALID', 'import_file destination must name a file');
  }
  let parent;
  try {
    parent = await fs.realpath(path.dirname(unresolved));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw importError('IMPORT_FILE_DESTINATION_INVALID', 'import_file parent must already exist');
    }
    throw error;
  }
  const parentStat = await fs.stat(parent);
  if (!parentStat.isDirectory()) throw importError('IMPORT_FILE_DESTINATION_INVALID', 'import_file parent must be a directory');
  return path.join(parent, name);
}

async function writeAll(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
      throw importError('IMPORT_FILE_WRITE_FAILED', 'import_file write made no progress');
    }
    offset += bytesWritten;
  }
}

export async function runImportFile({ defaultCwd, file, path: destinationPath, maxBytes }, signal) {
  const reference = normalizedReference(file);
  if (reference.size !== undefined && reference.size > maxBytes) {
    throw importError('IMPORT_FILE_TOO_LARGE', `ChatGPT file exceeds the ${maxBytes}-byte import limit`);
  }

  const destination = await resolveDestination(defaultCwd, destinationPath);
  const parent = path.dirname(destination);
  const partial = path.join(parent, `.webharness-import-${randomUUID()}.partial`);
  let handle;
  const response = await openSource(reference, signal);
  const hash = createHash('sha256');
  let size = 0;

  try {
    handle = await fs.open(
      partial,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );

    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      if (size + chunk.length > maxBytes) {
        throw importError('IMPORT_FILE_TOO_LARGE', `ChatGPT file exceeds the ${maxBytes}-byte import limit`);
      }
      await writeAll(handle, chunk, size);
      hash.update(chunk);
      size += chunk.length;
    }

    if (reference.size !== undefined && reference.size !== size) {
      throw importError('IMPORT_FILE_SIZE_MISMATCH', 'ChatGPT file metadata did not match downloaded content');
    }

    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.size !== size) {
      throw importError('IMPORT_FILE_WRITE_FAILED', 'Imported file could not be verified before publication');
    }

    await withMutationPath(destination, async () => {
      try {
        await fs.link(partial, destination);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw importError('IMPORT_FILE_DESTINATION_EXISTS', 'destination already exists');
        }
        throw error;
      }
    }, { signal });

    return {
      path: destinationPath,
      size,
      sha256: `sha256:${hash.digest('hex')}`,
    };
  } finally {
    await response.body?.cancel().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    await fs.unlink(partial).catch(() => undefined);
  }
}
