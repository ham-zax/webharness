const START_KEYS = new Set(['url', 'goal', 'scenario']);
const SCENARIO_KEYS = new Set(['browser_target', 'browser_backend', 'browser_profile', 'success']);
const SUCCESS_KEYS = new Set(['url_contains', 'title_contains', 'text_contains', 'required_operations']);
const RUN_KEYS = new Set(['run_id']);
const PROFILE_PATTERN = /^[A-Za-z0-9._-]+$/;

export const OPERATION_KINDS = Object.freeze({
  CLICK: 'click',
  TYPE_TEXT: 'fill',
  SELECT: 'select',
  WAIT: 'wait'
});

export const TERMINAL_STATUSES = new Set(['done', 'blocked', 'failed', 'stopped']);

function invalid(message) {
  const error = new Error(`INVALID_ARGUMENT: ${message}`);
  error.code = 'INVALID_ARGUMENT';
  return error;
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${name} must be an object`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalid(`${name} has unknown key: ${key}`);
  }
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function stringList(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(`${name} must be a non-empty array`);
  }
  return value.map((item, index) => nonEmptyString(item, `${name}[${index}]`));
}

function validateProfile(value) {
  if (value === undefined) return undefined;
  const profile = nonEmptyString(value, 'browser_profile');
  if (profile.length > 64 || profile === '.' || profile === '..' || !PROFILE_PATTERN.test(profile)) {
    throw invalid('browser_profile must be 1-64 characters using only letters, numbers, dot, underscore, or hyphen, and cannot be . or ..');
  }
  return profile;
}

function validateSuccess(value) {
  const success = requireObject(value, 'scenario.success');
  rejectUnknownKeys(success, SUCCESS_KEYS, 'scenario.success');
  if (Object.keys(success).length === 0) {
    throw invalid('scenario.success must contain at least one non-empty check');
  }
  const result = {};
  for (const key of ['url_contains', 'title_contains', 'text_contains']) {
    if (key in success) result[key] = stringList(success[key], `scenario.success.${key}`);
  }
  if ('required_operations' in success) {
    const operations = stringList(success.required_operations, 'scenario.success.required_operations');
    for (const operation of operations) {
      if (!Object.hasOwn(OPERATION_KINDS, operation)) {
        throw invalid(`scenario.success.required_operations must contain only ${Object.keys(OPERATION_KINDS).join(', ')}`);
      }
    }
    result.required_operations = operations;
  }
  return result;
}

export function validateStartArguments(value) {
  const args = requireObject(value, 'arguments');
  rejectUnknownKeys(args, START_KEYS, 'arguments');
  const rawUrl = nonEmptyString(args.url, 'url');
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw invalid('url must be an HTTP or HTTPS URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw invalid('url must be an HTTP or HTTPS URL without embedded credentials');
  }

  const scenario = requireObject(args.scenario, 'scenario');
  rejectUnknownKeys(scenario, SCENARIO_KEYS, 'scenario');
  const browserTarget = scenario.browser_target ?? 'windows';
  if (!['windows', 'linux'].includes(browserTarget)) {
    throw invalid('browser_target must be windows or linux');
  }
  let browserBackend = scenario.browser_backend;
  if (browserTarget === 'windows') {
    if (browserBackend !== undefined && browserBackend !== 'chrome') {
      throw invalid('Windows supports only the chrome backend');
    }
    browserBackend = 'chrome';
  } else if (browserBackend !== undefined && !['chrome', 'clearcote'].includes(browserBackend)) {
    throw invalid('browser_backend must be chrome or clearcote');
  }
  const browserProfile = validateProfile(scenario.browser_profile);
  if (browserTarget === 'linux' && browserProfile !== undefined && browserBackend === undefined) {
    throw invalid('browser_profile requires an explicit browser_backend for Linux');
  }

  return {
    url: url.href,
    goal: nonEmptyString(args.goal, 'goal'),
    scenario: {
      browser_target: browserTarget,
      browser_backend: browserBackend,
      browser_profile: browserProfile,
      success: validateSuccess(scenario.success)
    }
  };
}

export function validateRunId(value) {
  const args = requireObject(value, 'arguments');
  rejectUnknownKeys(args, RUN_KEYS, 'arguments');
  return nonEmptyString(args.run_id, 'run_id');
}

function pick(source, keys) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const result = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function numericMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(([, item]) => typeof item === 'number' && Number.isFinite(item));
  return Object.fromEntries(entries);
}

function usage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => (
    typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))
  )));
}

function sanitizeElement(element) {
  const result = pick(element, ['id', 'index', 'kind', 'label', 'role', 'value', 'checked', 'selected', 'expanded']);
  if (!result) return undefined;
  if (Array.isArray(element.operations)) {
    result.operations = element.operations.filter(operation => Object.hasOwn(OPERATION_KINDS, operation));
  }
  if (Array.isArray(element.options)) {
    result.options = element.options.map(option => pick(option, ['index', 'label', 'value'])).filter(Boolean);
  }
  return result;
}

function sanitizeDecision(decision) {
  const result = pick(decision, [
    'operation', 'choice', 'target', 'confidence', 'target_confidence', 'model', 'latency_ms'
  ]);
  if (!result) return undefined;
  for (const key of ['probabilities', 'operation_probabilities', 'target_probabilities']) {
    const value = numericMap(decision[key]);
    if (value !== undefined) result[key] = value;
  }
  const safeUsage = usage(decision.usage);
  if (safeUsage !== undefined) result.usage = safeUsage;
  return result;
}

function sanitizeHistory(entry) {
  const result = pick(entry, [
    'step', 'action', 'kind', 'choice', 'operation', 'target', 'probability', 'confidence',
    'latency_ms', 'text', 'text_helper', 'text_latency_ms', 'page_changed', 'url',
    'executed_ms', 'elapsed_ms'
  ]);
  if (!result) return undefined;
  const safeUsage = usage(entry.usage);
  if (safeUsage !== undefined) result.usage = safeUsage;
  return result;
}

export function sanitizeSnapshot(snapshot) {
  const source = requireObject(snapshot, 'snapshot');
  const result = pick(source, ['goal', 'status', 'elapsed_ms']);
  const page = pick(source.page, ['url', 'title', 'text']);
  if (page) {
    const scroll = pick(source.page?.scroll, ['x', 'y', 'height', 'max_y', 'viewport_height']);
    if (scroll) page.scroll = scroll;
    result.page = page;
  }
  if (Array.isArray(source.elements)) result.elements = source.elements.map(sanitizeElement).filter(Boolean);
  const decision = sanitizeDecision(source.decision);
  if (decision) result.decision = decision;
  if (Array.isArray(source.history)) result.history = source.history.map(sanitizeHistory).filter(Boolean);
  return result;
}

export function verifySuccess(snapshot, success) {
  const page = snapshot?.page ?? {};
  const historyKinds = new Set(Array.isArray(snapshot?.history) ? snapshot.history.map(entry => entry?.kind) : []);
  const checks = {};
  let passed = true;
  for (const [key, pageKey] of [
    ['url_contains', 'url'],
    ['title_contains', 'title'],
    ['text_contains', 'text']
  ]) {
    if (!(key in success)) continue;
    checks[key] = success[key].map(expected => {
      const itemPassed = typeof page[pageKey] === 'string' && page[pageKey].includes(expected);
      passed &&= itemPassed;
      return { expected, passed: itemPassed };
    });
  }
  if ('required_operations' in success) {
    checks.required_operations = {};
    for (const operation of success.required_operations) {
      const expectedKind = OPERATION_KINDS[operation];
      const itemPassed = historyKinds.has(expectedKind);
      passed &&= itemPassed;
      checks.required_operations[operation] = { expected_kind: expectedKind, passed: itemPassed };
    }
  }
  return { passed, checks };
}
