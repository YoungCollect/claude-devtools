/**
 * The Unified Agent Event Model.
 *
 * Nothing in here may reference an Anthropic-specific shape. Adapters
 * (src/core/adapters/*) translate a provider's wire format into these types, so
 * adding another provider or wire protocol means writing an adapter, not
 * touching the store or the UI.
 *
 * The model is deliberately split in two layers:
 *
 *   Transport layer — one record per HTTP request/response (`TransportRecord`).
 *   Trace layer     — the agent's conversation as a list of `TraceNode`s.
 *
 * They are NOT 1:1: a single HTTP request streams back many assistant/tool
 * nodes, and a tool result only becomes visible in the *next* request's body.
 * The two layers are joined by ids (`revealedByRequestId`, `producedByRequestId`)
 * which is exactly what makes "click a node → inspect its HTTP" possible.
 */

// ---------------------------------------------------------------------------
// Transport layer
// ---------------------------------------------------------------------------

export type ProviderId = 'anthropic' | 'unknown';

/**
 * A provider this build can actually read — everything except the
 * not-yet-identified case. This is the routing key: one adapter, one upstream,
 * one set of conversations per value.
 */
export type KnownProviderId = Exclude<ProviderId, 'unknown'>;

/**
 * The exhaustive runtime set. Claude DevTools intentionally supports exactly
 * the Anthropic protocol; keeping it beside the type prevents drift.
 */
export const PROVIDER_IDS = ['anthropic'] as const satisfies readonly KnownProviderId[];

/**
 * How a request relates to the agent's conversation.
 *
 * `utility` covers the side calls every agent runtime makes (title generation,
 * token counting, quota probes). They are real traffic and stay in the Network
 * view, but they would drown the Chat Trace, so the trace hides them by default.
 */
export type RequestKind = 'conversation' | 'utility' | 'other';

export interface SseFrame {
  /** ms since epoch, captured as the frame leaves the proxy toward the client. */
  t: number;
  /** `event:` field, if present. */
  event?: string;
  /** Parsed `data:` payload when it is JSON, otherwise undefined. */
  data?: unknown;
  /** The exact bytes of this frame, for the Raw tab. */
  raw: string;
}

export interface TransportTiming {
  /** Request line received by the proxy. */
  startedAt: number;
  /** Upstream response headers received (time to first byte). */
  ttfbAt?: number;
  /** First frame that carried model output (time to first token). */
  firstTokenAt?: number;
  /** Last byte forwarded to the client. */
  endedAt?: number;
}

export interface TransportRecord {
  id: string;
  provider: ProviderId;
  kind: RequestKind;

  method: string;
  /** Path as requested by the agent, e.g. `/v1/messages`. */
  path: string;
  /** Fully-qualified upstream URL the proxy forwarded to. */
  url: string;

  requestHeaders: Record<string, string>;
  requestBodyRaw?: string;
  requestBody?: unknown;

  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBodyRaw?: string;
  responseBody?: unknown;

  isStream: boolean;
  sseFrames: SseFrame[];

  timing: TransportTiming;
  requestBytes: number;
  responseBytes: number;

  /** Set when the proxy itself failed (DNS, socket, upstream reset). */
  error?: string;

  /**
   * True once the heavy fields have been written to disk and dropped from
   * memory. The API refills them from storage when the Inspector asks.
   */
  bodiesOffloaded?: boolean;

  /** Populated by the adapter once the request is understood. */
  model?: string;
  usage?: TokenUsage;
  conversationId?: string;
  /** Monotonic index of this request inside its conversation. */
  turnIndex?: number;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

// ---------------------------------------------------------------------------
// Trace layer
// ---------------------------------------------------------------------------

export type TraceNodeKind =
  | 'system'
  | 'context'
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'compaction';

export interface TraceNode {
  id: string;
  conversationId: string;
  kind: TraceNodeKind;
  /** Best-known wall-clock time for the node. */
  ts: number;

  /** Plain-text content for system/user/assistant/thinking nodes. */
  text?: string;

  /** Wrapper tag for context injected inside a user-role content block. */
  contextTag?: string;

  /**
   * Part of a call the session made *about* itself — naming the conversation,
   * checking quota — rather than a turn in it.
   *
   * On the trace because it is traffic the agent really made, and on the same
   * trace as the turns because the client says it is the same run. Marked so
   * the UI can show it as the aside it is, and so nothing downstream mistakes
   * its prompt for something the user typed.
   */
  sideCall?: boolean;

  /** Distinguishes the request-level prompt from a system-role history message. */
  systemSource?: 'prompt' | 'message';

  /**
   * Opaque location inside the captured request body that revealed this node.
   * Adapters create it; the core and UI only preserve and traverse it.
   */
  sourcePath?: Array<string | number>;

  /** tool_call / tool_result. */
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  isError?: boolean;

  /**
   * The request whose *body* first showed us this node. User messages and tool
   * results are only ever observed this way — they arrive as part of the next
   * request's history, never in a response.
   */
  revealedByRequestId?: string;
  /**
   * The request whose *response stream* generated this node. Only assistant,
   * thinking and tool_call nodes have one.
   */
  producedByRequestId?: string;

  /** Model wall time for assistant output; tool execution window for results. */
  durationMs?: number;
  /** True when the duration covers a batch of parallel tool calls, not just this one. */
  durationIsBatch?: boolean;

  usage?: TokenUsage;
  model?: string;
  /**
   * True when `model` was taken from the request that *revealed* this node
   * rather than from the response that produced it.
   *
   * An assistant turn replayed inside a later request's history carries no
   * model of its own — the request body names one model for the call it is
   * making, not one per history entry. That name is still real captured data
   * and is almost always the same model, but it is the model of a later turn,
   * so anything showing it has to be able to say so. `durationMs` has no such
   * fallback and stays absent: the wire carries no timing for a turn whose
   * response we never saw.
   */
  modelFromRequest?: boolean;
  stopReason?: string;
}

export interface Conversation {
  id: string;
  /** Short human label, derived from the first user message. */
  title: string;
  agent: string;
  provider: ProviderId;
  model?: string;
  startedAt: number;
  updatedAt: number;
  requestCount: number;
  nodeCount: number;
  usage: TokenUsage;
  /**
   * Set when this conversation was spawned by a tool call in another one — the
   * Task/subagent case. Lets the UI nest subagent traces under their parent.
   */
  parentConversationId?: string;
  parentToolUseId?: string;
}

// ---------------------------------------------------------------------------
// Wire shapes shared with the web UI
// ---------------------------------------------------------------------------

/** Trimmed `TransportRecord` for list views — omits the heavy body fields. */
export interface TransportSummary {
  id: string;
  provider: ProviderId;
  kind: RequestKind;
  method: string;
  path: string;
  status?: number;
  model?: string;
  isStream: boolean;
  startedAt: number;
  durationMs?: number;
  ttfbMs?: number;
  requestBytes: number;
  responseBytes: number;
  usage?: TokenUsage;
  conversationId?: string;
  turnIndex?: number;
  error?: string;
}

export interface StateSnapshot {
  rev: number;
  conversations: Conversation[];
  transport: TransportSummary[];
  /**
   * Exchanges open through the proxy right now — the agent is mid-request or
   * mid-stream. Distinct from anything derivable from `transport`: a restored
   * record whose process died mid-stream also lacks an end time, and a request
   * that outlives Clear is no longer listed at all.
   */
  activeRequests: number;
}

/** Provider-neutral materialisation of a streamed assistant response for the UI. */
export interface AssembledResponse {
  blocks: Array<{
    index: number;
    kind: string;
    name?: string;
    text: string;
  }>;
  stopReason?: string;
}

/**
 * Where each part of the trace lives in this provider's request body.
 *
 * The Inspector drills from a trace node into the JSON body and has to expand
 * the field that node came from. Only the adapter knows what that field is
 * called on the wire, so it names them here rather than the UI guessing.
 * A field is listed only when the body actually carries it.
 */
export interface RequestBodyFields {
  /** Top-level field holding the request-level system prompt. */
  system?: string;
  /** Top-level field holding the conversation history. */
  history?: string;
  /** Top-level field holding the tool declarations. */
  tools?: string;
}

/** Provider-neutral request details prepared by an adapter for the Inspector. */
export interface RequestInspection {
  summary: Array<{ label: string; value: string }>;
  toolNames: string[];
  systemText?: string;
  bodyFields?: RequestBodyFields;
}

/** Timing the Inspector reads off a record, derived rather than stored twice. */
export interface DerivedTiming {
  totalMs?: number;
  ttfbMs?: number;
  firstTokenMs?: number;
  streamMs?: number;
  frameCount: number;
}

/**
 * One transport exchange as the Inspector consumes it: the record plus the
 * adapter-derived views of it, with credentials already masked.
 *
 * Declared here — not beside either producer — because two of them exist. The
 * live API (`src/server/transport-view.ts`) serves this shape over HTTP, and
 * the static preview build bakes the identical shape to JSON. One type keeps
 * the second producer from drifting out from under the UI.
 */
export type TransportDetail = TransportRecord & {
  derivedTiming: DerivedTiming;
  assembledResponse?: AssembledResponse;
  requestInspection?: RequestInspection;
};
