// 1MCP rejects an argument object that fails the tool's input schema with the bare text
// "schema_input_invalid", which names neither the field nor the rule. This walks the
// same schema to name the violation, so a rejected call reads like Dev's own
// INVALID_ARGUMENTS: <tool>: <path>: <reason>.
//
// It only ever explains a call the upstream already rejected, so a construct it does
// not model costs detail, never a call: an unknown keyword is treated as satisfied and
// the original message stands.
const MAX_VIOLATIONS = 3;

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === 'integer') return actual === 'number' && Number.isInteger(value);
  if (type === 'number') return actual === 'number' && Number.isFinite(value);
  return actual === type;
}

function joinPath(path, key) {
  return path ? `${path}.${key}` : String(key);
}

function describe(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function collect(schema, value, path, out) {
  if (out.length >= MAX_VIOLATIONS) return;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  const where = path || '(root)';

  const variants = Array.isArray(schema.anyOf) ? schema.anyOf : (Array.isArray(schema.oneOf) ? schema.oneOf : null);
  if (variants && variants.length > 0) {
    // Report the closest branch: the one that fails the fewest rules. A union of
    // object shapes then names the missing key instead of "does not match".
    let closest = null;
    for (const variant of variants) {
      const found = [];
      collect(variant, value, path, found);
      if (found.length === 0) return;
      if (!closest || found.length < closest.length) closest = found;
    }
    out.push(...closest.slice(0, MAX_VIOLATIONS - out.length));
    return;
  }

  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    out.push(`${where}: expected ${describe(schema.const)}, received ${describe(value)}`);
    return;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && !schema.enum.includes(value)) {
    out.push(`${where}: expected one of ${schema.enum.map(describe).join(', ')}, received ${describe(value)}`);
    return;
  }
  if (typeof schema.type === 'string' && !matchesType(value, schema.type)) {
    out.push(`${where}: expected ${schema.type}, received ${typeOf(value)}`);
    return;
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) out.push(`${where}: must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) out.push(`${where}: must be <= ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) out.push(`${where}: must be > ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) out.push(`${where}: must be < ${schema.exclusiveMaximum}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) out.push(`${where}: must be at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) out.push(`${where}: must be at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value)) out.push(`${where}: must match ${schema.pattern}`);
      } catch {
        // A pattern this runtime cannot compile is not a violation we can name.
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) out.push(`${where}: must have at least ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) out.push(`${where}: must have at most ${schema.maxItems} items`);
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      value.forEach((item, index) => collect(schema.items, item, joinPath(path, index), out));
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, name)) out.push(`${where}: missing required property "${name}"`);
    }
    for (const [name, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, name)) collect(child, value[name], joinPath(path, name), out);
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(properties, name)) out.push(`${where}: unexpected property "${name}"`);
      }
    }
  }
}

/** First few violations of `value` against `schema`, or null when none are found. */
export function explainSchemaViolation(schema, value) {
  if (!schema || typeof schema !== 'object') return null;
  const out = [];
  collect(schema, value, '', out);
  return out.length > 0 ? out.slice(0, MAX_VIOLATIONS).join('; ') : null;
}
