import type {
  ProviderId,
  RequestKind,
  RequestInspection,
  SseFrame,
  TokenUsage,
  TraceNodeKind,
  TransportRecord,
} from '../types.js';

/**
 * One item of conversation history, normalised away from any provider's wire
 * format. A single provider "message" usually expands to several of these —
 * an assistant message carrying text plus two tool calls becomes three items.
 * Working at block granularity is what lets the trace show tool calls as
 * first-class nodes instead of burying them inside a message blob.
 */
export interface HistoryItem {
  /** Content hash. Equal fingerprints mean "the same thing in the transcript". */
  fp: string;
  kind: Extract<
    TraceNodeKind,
    'system' | 'context' | 'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result'
  >;
  text?: string;
  /** Display-only split of one provider block; `fp` still represents the original block. */
  segments?: HistorySegment[];
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  isError?: boolean;
}

export interface HistorySegment {
  kind: Extract<TraceNodeKind, 'system' | 'context' | 'user'>;
  text: string;
  contextTag?: string;
}

export interface ParsedRequest {
  provider: ProviderId;
  kind: RequestKind;
  /** Agent runtime that made the call, e.g. `claude-code`. Not the provider. */
  agent: string;
  model?: string;
  /** Hash of the system prompt — a tiebreaker when matching conversations. */
  systemFp: string;
  system?: string;
  history: HistoryItem[];
}

/** An assistant-side block observed while the response streamed back. */
export interface StreamBlockEvent {
  type: 'block_start' | 'block_delta' | 'block_stop' | 'message_start' | 'message_delta' | 'error';
  index?: number;
  kind?: Extract<TraceNodeKind, 'assistant' | 'thinking' | 'tool_call'>;
  /** Incremental text for `block_delta`, full text for `block_stop`. */
  text?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  model?: string;
  usage?: TokenUsage;
  stopReason?: string;
  error?: string;
  t: number;
}

/**
 * Translates one provider's protocol into the unified model.
 *
 * Implementations must be stateless with respect to conversations — all
 * cross-request correlation lives in `TraceBuilder`, so an adapter only ever
 * has to understand a single request/response pair.
 */
export interface ProviderAdapter {
  id: string;
  /** Does this adapter own the request? First match wins. */
  matches(record: TransportRecord): boolean;
  parseRequest(record: TransportRecord): ParsedRequest;
  /** Provider-neutral request summary for the transport Inspector. */
  inspectRequest(record: TransportRecord): RequestInspection | undefined;
  /** Streaming path: called per batch of SSE frames, in order. */
  parseStreamFrames(frames: SseFrame[]): StreamBlockEvent[];
  /** Non-streaming path: called once when the JSON body is complete. */
  parseResponseBody(record: TransportRecord): StreamBlockEvent[];
  /** Fingerprint an assembled assistant block so it matches the same block in later history. */
  fingerprintBlock(event: StreamBlockEvent): string;
}
