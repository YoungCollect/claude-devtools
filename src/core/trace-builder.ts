import { anthropicAdapter } from './adapters/anthropic.js';
import type { HistoryItem, ProviderAdapter, StreamBlockEvent } from './adapters/types.js';
import type { Store } from './store.js';
import type { Conversation, SseFrame, TokenUsage, TraceNode, TransportRecord } from './types.js';

const ADAPTERS: ProviderAdapter[] = [anthropicAdapter];

interface ConversationState {
  id: string;
  /** The transcript we believe the agent is holding, as block fingerprints. */
  fps: string[];
  /** Fingerprints we materialised from a response stream rather than from history. */
  producedFps: Set<string>;
  systemFp: string;
  turnCount: number;
  updatedAt: number;
}

interface StreamBlock {
  node: TraceNode;
  /** Raw accumulator: display text for text/thinking, partial JSON for tool calls. */
  buffer: string;
}

interface StreamState {
  conversationId: string;
  blocks: Map<number, StreamBlock>;
}

/**
 * Rebuilds the agent's conversation from nothing but the HTTP traffic.
 *
 * The trick that makes this possible: a chat-completions request carries the
 * *entire* transcript, and each successive request is a prefix-extension of the
 * last. So instead of trying to observe events as they happen, we diff request
 * N+1's history against what we already knew and treat the tail as newly
 * revealed. Combined with the response stream (which gives us the assistant
 * side live), that reconstructs the full trace losslessly — including tool
 * results, which never appear in any response.
 */
export class TraceBuilder {
  private readonly conversations = new Map<string, ConversationState>();
  private readonly streams = new Map<string, StreamState>();
  /** tool_use_id → conversation that issued it, for subagent attribution. */
  private readonly pendingToolCalls = new Map<string, { conversationId: string; toolName: string }>();
  private counter = 0;

  constructor(private readonly store: Store) {}

  // -- request side ---------------------------------------------------------

  onRequestBody(record: TransportRecord): void {
    const adapter = ADAPTERS.find((candidate) => candidate.matches(record));
    if (!adapter) {
      this.store.putTransport(record);
      this.store.touch();
      return;
    }

    const parsed = adapter.parseRequest(record);
    record.provider = parsed.provider;
    record.kind = parsed.kind;
    record.model = parsed.model;

    if (parsed.kind !== 'conversation') {
      this.store.putTransport(record);
      this.store.touch();
      return;
    }

    const state = this.attachToConversation(parsed.history, parsed.systemFp, record, parsed.agent);
    record.conversationId = state.id;
    record.turnIndex = state.turnCount++;

    this.revealNewHistory(state, parsed.history, record);

    this.store.putTransport(record);
    this.store.touch();
  }

  /**
   * Finds the conversation this request continues, or starts a new one.
   *
   * A request qualifies as a continuation if it shares at least one leading
   * block with a known transcript; the best (longest) match wins. Anything else
   * — a fresh session, a subagent with its own system prompt, a conversation
   * whose history was compacted out from under us — becomes a new trace.
   */
  private attachToConversation(
    history: HistoryItem[],
    systemFp: string,
    record: TransportRecord,
    agent: string,
  ): ConversationState {
    const fps = history.map((item) => item.fp);

    // Rank candidates by overlap first, then by matching system prompt, then by
    // recency. The system-prompt tiebreaker is what keeps a subagent from being
    // absorbed into its parent when the two happen to share a leading block.
    let best: { state: ConversationState; score: [number, number, number] } | undefined;
    for (const state of this.conversations.values()) {
      const common = commonPrefixLength(state.fps, fps);
      if (common === 0) continue;
      const score: [number, number, number] = [
        common,
        state.systemFp === systemFp ? 1 : 0,
        state.updatedAt,
      ];
      if (!best || compareScores(score, best.score) > 0) best = { state, score };
    }

    if (best) {
      const state = best.state;
      const common = best.score[0];
      if (common < state.fps.length) {
        // The agent is holding less history than we recorded: a compaction, a
        // context edit, or a stream we captured only partially. Trust the agent.
        const dropped = state.fps.length - common;
        if (dropped > 2) {
          this.append({
            conversationId: state.id,
            kind: 'compaction',
            ts: record.timing.startedAt,
            text: `History rewound: ${dropped} block(s) dropped by the agent (context compaction or edit).`,
            revealedByRequestId: record.id,
          });
        }
        state.fps.length = common;
      }
      state.updatedAt = record.timing.startedAt;
      return state;
    }

    return this.createConversation(history, systemFp, record, agent);
  }

  private createConversation(
    history: HistoryItem[],
    systemFp: string,
    record: TransportRecord,
    agent: string,
  ): ConversationState {
    const id = `conv_${++this.counter}`;
    const state: ConversationState = {
      id,
      fps: [],
      producedFps: new Set(),
      systemFp,
      turnCount: 0,
      updatedAt: record.timing.startedAt,
    };
    this.conversations.set(id, state);

    // A trace that appears while a `Task` tool call is still outstanding is
    // almost certainly that subagent's own conversation. Linking them lets the
    // UI nest the subagent under the tool call that spawned it.
    const parent = this.findPendingSubagentParent();

    const conversation: Conversation = {
      id,
      title: deriveTitle(history) ?? 'Untitled conversation',
      agent,
      provider: record.provider,
      model: record.model,
      startedAt: record.timing.startedAt,
      updatedAt: record.timing.startedAt,
      requestCount: 0,
      nodeCount: 0,
      usage: {},
      parentConversationId: parent?.conversationId,
      parentToolUseId: parent?.toolUseId,
    };
    this.store.putConversation(conversation);
    return state;
  }

  private findPendingSubagentParent(): { conversationId: string; toolUseId: string } | undefined {
    // Map iteration is insertion-ordered; the newest pending Task wins.
    let match: { conversationId: string; toolUseId: string } | undefined;
    for (const [toolUseId, info] of this.pendingToolCalls) {
      if (info.toolName === 'Task') match = { conversationId: info.conversationId, toolUseId };
    }
    return match;
  }

  /**
   * Everything past the shared prefix is new information. In practice that's
   * the user's latest message plus the tool results for the previous turn's
   * calls — neither of which exists anywhere in a response body.
   */
  private revealNewHistory(
    state: ConversationState,
    history: HistoryItem[],
    record: TransportRecord,
  ): void {
    for (let i = state.fps.length; i < history.length; i++) {
      const item = history[i];
      if (!item) continue;
      state.fps.push(item.fp);

      // Assistant-side blocks are normally already on the trace, materialised
      // live from the response stream. They only show up here when the proxy
      // started mid-conversation.
      if (state.producedFps.has(item.fp)) continue;

      if (item.kind === 'tool_result') {
        this.appendToolResult(state, item, record);
        continue;
      }

      this.append({
        conversationId: state.id,
        kind: item.kind,
        ts: record.timing.startedAt,
        text: item.text,
        toolName: item.toolName,
        toolUseId: item.toolUseId,
        toolInput: item.toolInput,
        revealedByRequestId: record.id,
      });
    }

    const conversation = this.store.getConversation(state.id);
    if (conversation) {
      conversation.requestCount += 1;
      conversation.updatedAt = record.timing.startedAt;
    }
  }

  private appendToolResult(
    state: ConversationState,
    item: HistoryItem,
    record: TransportRecord,
  ): void {
    const call = item.toolUseId
      ? this.store.findNode((node) => node.kind === 'tool_call' && node.toolUseId === item.toolUseId)
      : undefined;

    // The gap between the end of the response that requested the tool and the
    // start of the request carrying its result *is* the tool's execution time.
    // No agent-side instrumentation required.
    let durationMs: number | undefined;
    let durationIsBatch = false;
    if (call?.producedByRequestId) {
      const producing = this.store.getTransport(call.producedByRequestId);
      const finishedAt = producing?.timing.endedAt;
      if (finishedAt !== undefined) {
        durationMs = Math.max(0, record.timing.startedAt - finishedAt);
        const siblings = this.store
          .getNodes(state.id)
          .filter(
            (node) =>
              node.kind === 'tool_call' && node.producedByRequestId === call.producedByRequestId,
          );
        durationIsBatch = siblings.length > 1;
      }
    }

    if (item.toolUseId) this.pendingToolCalls.delete(item.toolUseId);

    this.append({
      conversationId: state.id,
      kind: 'tool_result',
      ts: record.timing.startedAt,
      toolName: call?.toolName ?? item.toolName,
      toolUseId: item.toolUseId,
      toolResult: item.toolResult,
      isError: item.isError,
      revealedByRequestId: record.id,
      durationMs,
      durationIsBatch,
    });
  }

  // -- response side --------------------------------------------------------

  onStreamFrames(record: TransportRecord, frames: SseFrame[]): void {
    const adapter = ADAPTERS.find((candidate) => candidate.matches(record));
    if (!adapter || !record.conversationId) return;
    this.applyEvents(adapter, record, adapter.parseStreamFrames(frames));
    this.store.touch();
  }

  onComplete(record: TransportRecord): void {
    const adapter = ADAPTERS.find((candidate) => candidate.matches(record));
    if (adapter && record.conversationId && !record.isStream) {
      this.applyEvents(adapter, record, adapter.parseResponseBody(record));
    }
    if (record.error && record.conversationId) {
      this.append({
        conversationId: record.conversationId,
        kind: 'error',
        ts: record.timing.endedAt ?? Date.now(),
        text: record.error,
        producedByRequestId: record.id,
      });
    }
    // Roll the turn's tokens into the conversation total exactly once. Doing
    // this while frames were still arriving would count each partial update
    // again on every subsequent frame.
    if (record.conversationId) {
      const conversation = this.store.getConversation(record.conversationId);
      if (conversation) conversation.usage = mergeUsage(conversation.usage, record.usage, true);
    }
    this.streams.delete(record.id);
    this.store.putTransport(record);
    this.store.touch();
  }

  private applyEvents(
    adapter: ProviderAdapter,
    record: TransportRecord,
    events: StreamBlockEvent[],
  ): void {
    const conversationId = record.conversationId;
    if (!conversationId) return;
    const state = this.conversations.get(conversationId);
    if (!state) return;

    let stream = this.streams.get(record.id);
    if (!stream) {
      stream = { conversationId, blocks: new Map() };
      this.streams.set(record.id, stream);
    }

    for (const event of events) {
      switch (event.type) {
        case 'message_start':
          if (event.model) record.model = event.model;
          record.usage = mergeUsage(record.usage, event.usage);
          break;

        case 'block_start': {
          if (event.index === undefined || !event.kind) break;
          const node = this.append({
            conversationId,
            kind: event.kind,
            ts: event.t,
            text: event.kind === 'tool_call' ? undefined : (event.text ?? ''),
            toolName: event.toolName,
            toolUseId: event.toolUseId,
            toolInput: event.toolInput,
            producedByRequestId: record.id,
            model: record.model,
          });
          stream.blocks.set(event.index, { node, buffer: event.text ?? '' });
          break;
        }

        case 'block_delta': {
          if (event.index === undefined) break;
          const block = stream.blocks.get(event.index);
          if (!block) break;
          block.buffer += event.text ?? '';
          if (block.node.kind !== 'tool_call') block.node.text = block.buffer;
          break;
        }

        case 'block_stop': {
          if (event.index === undefined) break;
          const block = stream.blocks.get(event.index);
          if (!block) break;
          this.finalizeBlock(adapter, state, block, event.t);
          break;
        }

        case 'message_delta':
          record.usage = mergeUsage(record.usage, event.usage);
          if (event.stopReason) {
            for (const block of stream.blocks.values()) block.node.stopReason = event.stopReason;
          }
          break;

        case 'error':
          this.append({
            conversationId,
            kind: 'error',
            ts: event.t,
            text: event.error,
            producedByRequestId: record.id,
          });
          break;
      }
    }

    const conversation = this.store.getConversation(conversationId);
    if (conversation && record.model) conversation.model = record.model;
  }

  private finalizeBlock(
    adapter: ProviderAdapter,
    state: ConversationState,
    block: StreamBlock,
    t: number,
  ): void {
    const node = block.node;
    node.durationMs = Math.max(0, t - node.ts);

    if (node.kind === 'tool_call') {
      if (node.toolInput === undefined) {
        node.toolInput = block.buffer ? safeJsonParse(block.buffer) : {};
      }
      if (node.toolUseId) {
        this.pendingToolCalls.set(node.toolUseId, {
          conversationId: state.id,
          toolName: node.toolName ?? '',
        });
      }
    }

    // An empty text block is dropped from the transcript the agent replays back
    // to us, so it must not enter the fingerprint list either — otherwise the
    // next request's prefix match would come up short.
    if (node.kind !== 'tool_call' && !(node.text ?? '').trim()) return;

    const fp = adapter.fingerprintBlock({
      type: 'block_stop',
      kind: node.kind === 'thinking' ? 'thinking' : node.kind === 'tool_call' ? 'tool_call' : 'assistant',
      text: node.text,
      toolName: node.toolName,
      toolUseId: node.toolUseId,
      toolInput: node.toolInput,
      t,
    });
    state.fps.push(fp);
    state.producedFps.add(fp);
  }

  // -- helpers --------------------------------------------------------------

  private append(node: Omit<TraceNode, 'id'>): TraceNode {
    const full: TraceNode = { id: `node_${++this.counter}`, ...node };
    this.store.appendNode(full);
    return full;
  }
}

/** Lexicographic compare of the candidate ranking tuple. */
function compareScores(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function mergeUsage(
  base: TokenUsage | undefined,
  next: TokenUsage | undefined,
  accumulate = false,
): TokenUsage {
  const out: TokenUsage = { ...base };
  if (!next) return out;
  for (const key of Object.keys(next) as (keyof TokenUsage)[]) {
    const value = next[key];
    if (value === undefined) continue;
    out[key] = accumulate ? (out[key] ?? 0) + value : value;
  }
  return out;
}

/**
 * Claude Code wraps injected context in `<system-reminder>` blocks and often
 * prefixes the first turn with them. Strip those so the trace title is the
 * thing the human actually typed.
 */
function deriveTitle(history: HistoryItem[]): string | undefined {
  for (const item of history) {
    if (item.kind !== 'user' || !item.text) continue;
    const cleaned = item.text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) return cleaned.length > 80 ? `${cleaned.slice(0, 80)}…` : cleaned;
  }
  return undefined;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { __unparsed: text };
  }
}
