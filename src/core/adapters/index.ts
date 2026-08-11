import { anthropicAdapter } from './anthropic.js';
import type { ProviderAdapter, StreamBlockEvent } from './types.js';
import type { AssembledResponse, RequestInspection, TransportRecord } from '../types.js';

const ADAPTERS: ProviderAdapter[] = [anthropicAdapter];

/** Returns the first provider adapter that owns this transport request. */
export function findAdapter(record: TransportRecord): ProviderAdapter | undefined {
  return ADAPTERS.find((candidate) => candidate.matches(record));
}

/**
 * Whether any known provider dispatches subagents through this tool.
 *
 * Used where there is no request to pick an adapter from — restoring pending
 * calls from persisted nodes after a restart. Tool names are distinctive enough
 * that asking every adapter is safe, and it keeps the names themselves out of
 * the builder.
 */
export function isSubagentTool(toolName: string): boolean {
  return ADAPTERS.some((adapter) => adapter.isSubagentTool(toolName));
}

export function inspectRequest(record: TransportRecord): RequestInspection | undefined {
  return findAdapter(record)?.inspectRequest(record);
}

/**
 * Converts provider-specific SSE frames into a provider-neutral response model.
 * The API sends this model to the UI, so React never interprets wire protocols.
 */
export function assembleStreamResponse(record: TransportRecord): AssembledResponse | undefined {
  if (!record.isStream) return undefined;
  const adapter = findAdapter(record);
  if (!adapter) return undefined;

  const blocks = new Map<
    number,
    { index: number; kind: string; name?: string; text: string }
  >();
  let stopReason: string | undefined;

  for (const event of adapter.parseStreamFrames(record.sseFrames)) {
    applyEvent(blocks, event);
    if (event.type === 'message_delta' && event.stopReason) stopReason = event.stopReason;
  }

  return {
    blocks: [...blocks.values()].sort((a, b) => a.index - b.index),
    stopReason,
  };
}

function applyEvent(
  blocks: Map<number, { index: number; kind: string; name?: string; text: string }>,
  event: StreamBlockEvent,
): void {
  if (event.index === undefined) return;
  if (event.type === 'block_start') {
    blocks.set(event.index, {
      index: event.index,
      kind: event.kind ?? 'assistant',
      text: event.text ?? '',
      ...(event.toolName !== undefined ? { name: event.toolName } : {}),
    });
    return;
  }
  if (event.type === 'block_delta') {
    const block = blocks.get(event.index);
    if (block) block.text += event.text ?? '';
  }
}
