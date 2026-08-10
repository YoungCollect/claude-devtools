import type { RequestBodyFields, TraceNode } from '../core/types.js';

/**
 * Which top-level request-body field a trace node came out of.
 *
 * This is the drill-down's last mile: the trace says "this is the system
 * prompt", the adapter says the provider calls that field `system`, and the
 * Inspector expands exactly that node of the JSON tree. Returning `undefined`
 * is a normal outcome — synthetic rows like the compaction banner have no field
 * of their own, and a request that sent no tools names none.
 */
export function focusBodyField(
  node: TraceNode | undefined,
  fields: RequestBodyFields | undefined,
): string | undefined {
  if (!node || !fields) return undefined;

  switch (node.kind) {
    case 'system':
      // A system-role *message* is part of the history; only the request-level
      // prompt is a field of its own.
      return node.systemSource === 'message' ? fields.history : fields.system;
    case 'context':
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'tool_call':
    case 'tool_result':
      return fields.history;
    case 'compaction':
    case 'error':
      // Both are reconstructed by the trace builder rather than read out of a
      // body field, so there is nothing to point at.
      return undefined;
  }
}
