export type JsonContainer = Record<string, unknown> | unknown[];

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
