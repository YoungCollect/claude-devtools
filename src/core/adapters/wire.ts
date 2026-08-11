/**
 * Reading unknown JSON, shared by every adapter.
 *
 * A captured body is whatever the agent actually sent — it is not validated,
 * not typed, and a malformed one must never take the proxy down. These are the
 * narrowings that turn `unknown` into something an adapter can branch on, kept
 * in one place so two providers cannot disagree about what "a string" means.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** The request path without its query string. */
export function pathname(path: string): string {
  const query = path.indexOf('?');
  return query === -1 ? path : path.slice(0, query);
}
