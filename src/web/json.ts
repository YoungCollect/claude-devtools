export type JsonContainer = Record<string, unknown> | unknown[];

export type JsonNodeExpansion = (level: number, value: unknown, field?: string) => boolean;

/** Builds the initial expansion rule for a request/response JSON tree. */
export function jsonNodeExpansion(
  data: JsonContainer | undefined,
  expandFields: readonly string[],
): JsonNodeExpansion {
  const focused = new Set(expandFields);
  const focusedChildren = new Set<JsonContainer>();

  if (data && !Array.isArray(data)) {
    for (const field of focused) {
      const value = data[field];
      if (!isContainer(value)) continue;
      const children = Array.isArray(value) ? value : Object.values(value);
      for (const child of children) {
        if (isContainer(child)) focusedChildren.add(child);
      }
    }
  }

  return (level, _value, field) =>
    level < 1 ||
    (level === 1 && field !== undefined && focused.has(field)) ||
    (level === 2 && isContainer(_value) && focusedChildren.has(_value));
}

/** Returns a tree-renderable JSON object/array, parsing raw HTTP text as a fallback. */
export function jsonContainer(value: unknown, raw?: string): JsonContainer | undefined {
  if (isContainer(value)) return value;
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isContainer(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isContainer(value: unknown): value is JsonContainer {
  return typeof value === 'object' && value !== null;
}
