/**
 * Everything this tool captures is sensitive: `x-api-key` and `authorization`
 * carry live credentials, and request bodies carry whole source files. The
 * store keeps the raw bytes (you cannot debug what you cannot see), so the
 * redaction boundary sits at the API layer instead — headers go out masked
 * unless the caller explicitly asks to reveal them.
 */

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'anthropic-auth-token',
  'openai-api-key',
  'x-goog-api-key',
]);

/**
 * Catches the credential headers no list anticipated — a new provider, a
 * corporate gateway, a bespoke agent runtime. A named list alone fails open,
 * which is the wrong direction for a value that gets written to disk: masking
 * something harmless costs a reveal click, missing something real leaks a key.
 */
const SENSITIVE_PATTERN = /(^|[-_])(api[-_]?key|auth|authorization|token|secret|credential|password|session)([-_]|$)/i;

export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADERS.has(lower) || SENSITIVE_PATTERN.test(lower);
}

/** `sk-ant-oat01-abc…xyz` — enough to tell two keys apart, not enough to use one. */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 12) return '••••••';
  const scheme = /^(Bearer|Basic|Token)\s+/i.exec(trimmed);
  const prefixLen = scheme ? scheme[0].length : 0;
  const body = trimmed.slice(prefixLen);
  const head = body.slice(0, 10);
  const tail = body.slice(-4);
  return `${trimmed.slice(0, prefixLen)}${head}…${'•'.repeat(6)}…${tail}`;
}

export function redactHeaders(
  headers: Record<string, string>,
  reveal: boolean,
): Record<string, string> {
  if (reveal) return headers;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSensitiveHeader(key) ? maskSecret(value) : value;
  }
  return out;
}
