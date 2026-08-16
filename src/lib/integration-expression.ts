/**
 * Safe expression evaluator for the integration platform.
 * NO eval(), NO new Function(). Pure string parsing and object traversal.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMPLATE_RE = /\{\{([^}]+)\}\}/g;

/**
 * Walk a dot-separated path into an object, supporting numeric array indices.
 * Returns `undefined` when the path cannot be resolved.
 */
function walkPath(obj: unknown, path: string): unknown {
  const segments = path.trim().split('.');
  let current: unknown = obj;
  for (const seg of segments) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/** Coerce a resolved value to a display string. */
function valueToString(val: unknown): string {
  if (val === undefined || val === null) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * UTF-8 safe base64. `btoa` throws on any code point above U+00FF, which a
 * company name or password can easily contain, so encode to bytes first.
 */
function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Value transforms usable as `{{path | filter}}` in any template string.
 *
 * Deliberately a fixed table rather than anything evaluated — the whole point
 * of this module is that no expression ever reaches `eval` or `new Function`.
 */
const FILTERS: Record<string, (value: string) => string> = {
  base64: utf8ToBase64,
  base64url: (v) => utf8ToBase64(v).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  urlencode: encodeURIComponent,
  upper: (v) => v.toUpperCase(),
  lower: (v) => v.toLowerCase(),
  trim: (v) => v.trim(),
};

export const AVAILABLE_FILTERS = Object.keys(FILTERS);

/**
 * Every single-filter encoding of a secret.
 *
 * Log redaction matches on literal strings, so a secret that reaches the log
 * already encoded — `{{config.privateKey | base64}}` — would sail past a
 * redactor that only knows the raw value. Callers redact these variants too.
 */
export function secretVariants(secret: string): string[] {
  const variants = new Set<string>();
  for (const fn of Object.values(FILTERS)) {
    try {
      const encoded = fn(secret);
      if (encoded && encoded !== secret) variants.add(encoded);
    } catch {
      // A filter that cannot encode this value simply contributes no variant.
    }
  }
  return [...variants];
}

/** Thrown when a template names a filter that does not exist. */
export class UnknownFilterError extends Error {
  readonly filter: string;

  constructor(filter: string) {
    super(`Unknown filter "${filter}". Available: ${AVAILABLE_FILTERS.join(', ')}`);
    this.name = 'UnknownFilterError';
    this.filter = filter;
  }
}

/**
 * Split `path | filter | filter` into its parts.
 *
 * A token with no pipe is a bare path, which is the overwhelmingly common case
 * and must stay byte-identical to the pre-filter behaviour.
 */
function parseToken(token: string): { path: string; filters: string[] } {
  if (!token.includes('|')) return { path: token, filters: [] };
  const [path, ...filters] = token.split('|');
  return { path, filters: filters.map((f) => f.trim()).filter(Boolean) };
}

/**
 * Apply a filter chain left to right.
 *
 * An unrecognised filter throws rather than passing the value through
 * untouched. Silently ignoring a typo would mean `{{config.secret | base64}}`
 * mis-spelled sends the raw secret in cleartext — a failure that looks like
 * success until you read a packet capture.
 */
function applyFilters(value: string, filters: string[]): string {
  let result = value;
  for (const name of filters) {
    const fn = FILTERS[name];
    if (!fn) throw new UnknownFilterError(name);
    result = fn(result);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 1. resolveVariables
// ---------------------------------------------------------------------------

/**
 * Replace `{{path.to.value}}` tokens in a template string with values from
 * `context`. Objects / arrays are JSON-stringified; unresolvable paths become
 * empty strings.
 *
 * A token may pipe the resolved value through filters — `{{config.key | base64}}`
 * — which is how templates build credentials they cannot express as a plain
 * path. See `AVAILABLE_FILTERS`.
 */
export function resolveVariables(
  template: string,
  context: Record<string, unknown>,
): string {
  return template.replace(TEMPLATE_RE, (_, token: string) => {
    const { path, filters } = parseToken(token);
    const val = walkPath(context, path);
    return applyFilters(valueToString(val), filters);
  });
}

// ---------------------------------------------------------------------------
// 2. evaluateCondition
// ---------------------------------------------------------------------------

type Operator =
  | '=='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'exists'
  | 'not-exists'
  | 'contains'
  | 'startsWith'
  | 'endsWith';

const OPERATORS: Operator[] = [
  '!=',
  '==',
  '>=',
  '<=',
  '>',
  '<',
  'not-exists',
  'exists',
  'contains',
  'startsWith',
  'endsWith',
];

/**
 * Split an expression around the first recognised operator.
 * Returns `[left, operator, right]` or `null` if no operator found.
 */
function splitOperator(
  expr: string,
): [string, Operator, string] | null {
  const trimmed = expr.trim();
  for (const op of OPERATORS) {
    // For word-based operators, ensure they are surrounded by whitespace so we
    // don't match partial words (e.g. "existsNot").
    if (/^[a-z]/.test(op)) {
      const re = new RegExp(`\\s+${op}(?:\\s+|$)`);
      const match = re.exec(trimmed);
      if (match) {
        const idx = match.index;
        const left = trimmed.slice(0, idx).trim();
        const right = trimmed.slice(idx + match[0].length).trim();
        return [left, op, right];
      }
    } else {
      // Symbol operators like ==, !=, >=, etc.
      const idx = trimmed.indexOf(` ${op} `);
      if (idx !== -1) {
        const left = trimmed.slice(0, idx).trim();
        const right = trimmed.slice(idx + op.length + 2).trim();
        return [left, op, right];
      }
    }
  }
  return null;
}

/**
 * Evaluate a single comparison expression (no `and`/`or`).
 */
function evaluateSingle(
  expr: string,
  context: Record<string, unknown>,
): boolean {
  // Resolve all {{...}} tokens first so the expression contains plain values.
  const resolved = resolveVariables(expr, context);

  const parts = splitOperator(resolved);
  if (!parts) {
    // No operator found — treat non-empty resolved string as truthy.
    return resolved.trim().length > 0;
  }

  const [left, op, right] = parts;

  switch (op) {
    case 'exists':
      return left !== '';
    case 'not-exists':
      return left === '';
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '>':
      return Number(left) > Number(right);
    case '>=':
      return Number(left) >= Number(right);
    case '<':
      return Number(left) < Number(right);
    case '<=':
      return Number(left) <= Number(right);
    case 'contains':
      return left.includes(right);
    case 'startsWith':
      return left.startsWith(right);
    case 'endsWith':
      return left.endsWith(right);
    default:
      return false;
  }
}

/**
 * Split a compound expression on ` and ` / ` or ` combinators.
 * Returns an array of `{ expr, combinator }` entries evaluated left-to-right
 * (no precedence — matches spec).
 */
function splitCombinators(
  expression: string,
): { expr: string; combinator: 'and' | 'or' | null }[] {
  const results: { expr: string; combinator: 'and' | 'or' | null }[] = [];
  let remaining = expression;

  for (;;) {
    // Find the first ` and ` or ` or ` (must be surrounded by spaces).
    const andIdx = remaining.indexOf(' and ');
    const orIdx = remaining.indexOf(' or ');

    let chosen: 'and' | 'or' | null = null;
    let idx = -1;
    if (andIdx !== -1 && (orIdx === -1 || andIdx < orIdx)) {
      chosen = 'and';
      idx = andIdx;
    } else if (orIdx !== -1) {
      chosen = 'or';
      idx = orIdx;
    }

    if (chosen === null || idx === -1) {
      results.push({ expr: remaining.trim(), combinator: null });
      break;
    }

    const left = remaining.slice(0, idx).trim();
    const skipLen = chosen === 'and' ? 5 : 4; // ' and ' or ' or '
    remaining = remaining.slice(idx + skipLen);
    results.push({ expr: left, combinator: chosen });
  }

  return results;
}

/**
 * Evaluate a comparison expression. Supports `and` / `or` combinators
 * evaluated strictly left-to-right (no operator precedence).
 *
 * Examples:
 * - `{{path}} == value`
 * - `{{a}} > 5 and {{b}} contains hello`
 */
export function evaluateCondition(
  expression: string,
  context: Record<string, unknown>,
): boolean {
  const parts = splitCombinators(expression);
  let result = evaluateSingle(parts[0].expr, context);

  for (let i = 0; i < parts.length - 1; i++) {
    const nextResult = evaluateSingle(parts[i + 1].expr, context);
    if (parts[i].combinator === 'and') {
      result = result && nextResult;
    } else {
      result = result || nextResult;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 3. resolveDeep
// ---------------------------------------------------------------------------

/**
 * Recursively walk an object/array and resolve all `{{...}}` tokens found in
 * string values. Non-string leaves are returned as-is.
 */
export function resolveDeep(
  obj: unknown,
  context: Record<string, unknown>,
): unknown {
  if (typeof obj === 'string') {
    return resolveVariables(obj, context);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveDeep(item, context));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = resolveDeep(val, context);
    }
    return result;
  }
  // Primitives (number, boolean, null, undefined) pass through.
  return obj;
}
