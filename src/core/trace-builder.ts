import { findAdapter, isSubagentTool } from './adapters/index.js';
import type {
  HistoryItem,
  ParsedRequest,
  ProviderAdapter,
  StreamBlockEvent,
} from './adapters/types.js';
import type { Store } from './store.js';
import type {
  Conversation,
  KnownProviderId,
  ProviderId,
  SseFrame,
  TokenUsage,
  TraceNode,
  TransportRecord,
} from './types.js';

/**
 * How many sessions may hold an unattached side call.
 *
 * A run id that never opens a conversation — a probe, an agent that exited
 * before its first turn — would otherwise be remembered forever. The bound is
 * generous because the entries are two references each, and losing one only
 * costs a side call its place on a trace it may never have had.
 */
const MAX_PENDING_SIDE_CALL_SESSIONS = 64;

/** Reconstruction state for one conversation. Persisted so a restart resumes
 * an in-flight agent session instead of starting a second trace for it. */
export interface ConversationState {
  id: string;
  /**
   * The provider this trace belongs to.
   *
   * A precondition for continuing it, never a tiebreaker. Kept on persisted
   * state so older captures stay explicit about the protocol they contain.
   * Optional because a conversation restored from a database written
   * before this field existed has no answer, and inventing one would split a
   * trace that is mid-run.
   */
  provider?: KnownProviderId;
  /** The transcript we believe the agent is holding, as block fingerprints. */
  fps: string[];
  /** Fingerprints already materialised from a response stream, including
   * history-normalized aliases for the same provider block identity. */
  producedFps: Set<string>;
  /** The agent runtime's own run id, when it sent one. */
  sessionId?: string;
  systemFp: string;
  turnCount: number;
  updatedAt: number;
}

interface StreamBlock {
  node: TraceNode;
  /** Raw accumulator: display text for text/thinking, partial JSON for tool calls. */
  buffer: string;
  /** Finalised once. Guards the two paths that can close a block (see `onComplete`). */
  closed?: boolean;
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
  private readonly pendingToolCalls = new Map<
    string,
    { conversationId: string; toolName: string; isSubagent: boolean }
  >();
  /**
   * Side calls whose session has not opened a conversation yet, by run id.
   *
   * Claude Code fires its title call alongside the first turn, and it has been
   * observed arriving first, so "no conversation yet" is the ordinary case.
   */
  private readonly pendingSideCalls = new Map<
    string,
    { parsed: ParsedRequest; record: TransportRecord }[]
  >();
  private counter = 0;
  /** Ids touched since the last drain, so persistence writes only what changed. */
  private readonly dirtyNodeIds = new Set<string>();
  private readonly dirtyConversationIds = new Set<string>();

  constructor(private readonly store: Store) {}

  // -- request side ---------------------------------------------------------

  onRequestBody(record: TransportRecord): void {
    const adapter = findAdapter(record);
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
      this.attachSideCall(parsed, record);
      this.store.putTransport(record);
      this.store.touch();
      return;
    }

    const state = this.attachToConversation(parsed, record);
    record.conversationId = state.id;
    record.turnIndex = state.turnCount++;

    this.revealNewHistory(state, parsed.history, record);

    this.store.putTransport(record);
    this.store.touch();
  }

  /**
   * Puts a side call on its session's trace without letting it into the
   * transcript.
   *
   * The two halves are deliberate. It joins the conversation because the client
   * says so — Claude Code stamps a side call with the same run id as the turns
   * around it — and a separate trace per title call was one row of noise per
   * message, titled with the prompt that generated it.
   *
   * It stays out of `state.fps` because the transcript is the thing every later
   * request is diffed against. A side call holds one message that no turn will
   * ever repeat, so folding it in would leave a permanent phantom at the head of
   * the history: the next real request would share no prefix with it, and the
   * rewind branch would read that as a compaction.
   *
   * Arriving before its conversation is the normal case, not the exception —
   * Claude Code fires the title call and the first turn together, and the title
   * call has been observed landing first. So an unmatched one waits for the
   * session to appear rather than being dropped.
   */
  private attachSideCall(parsed: ParsedRequest, record: TransportRecord): void {
    const sessionId = parsed.sessionId;
    if (!sessionId) return;

    for (const state of this.conversations.values()) {
      if (state.sessionId !== sessionId) continue;
      if (state.provider && state.provider !== parsed.provider) continue;
      this.revealSideCall(state, parsed, record);
      return;
    }

    // Held until the session opens a conversation. Bounded because a run id
    // that never sends a turn — a probe, an agent that died before its first
    // request — would otherwise be remembered for the life of the process.
    const waiting = this.pendingSideCalls.get(sessionId) ?? [];
    waiting.push({ parsed, record });
    this.pendingSideCalls.set(sessionId, waiting);
    while (this.pendingSideCalls.size > MAX_PENDING_SIDE_CALL_SESSIONS) {
      const oldest = this.pendingSideCalls.keys().next();
      if (oldest.done) break;
      this.pendingSideCalls.delete(oldest.value);
    }
  }

  /** Appends a side call's own exchange, marked, and leaves `fps` untouched. */
  private revealSideCall(
    state: ConversationState,
    parsed: ParsedRequest,
    record: TransportRecord,
  ): void {
    record.conversationId = state.id;
    record.turnIndex = state.turnCount++;

    if (parsed.system?.trim()) {
      this.append({
        conversationId: state.id,
        kind: 'system',
        ts: record.timing.startedAt,
        text: parsed.system,
        systemSource: 'prompt',
        sideCall: true,
        revealedByRequestId: record.id,
      });
    }

    for (const item of parsed.history) {
      if (item.kind === 'tool_result' || !item.text) continue;
      this.append({
        conversationId: state.id,
        kind: item.kind,
        ts: record.timing.startedAt,
        text: item.text,
        sourcePath: item.sourcePath,
        sideCall: true,
        revealedByRequestId: record.id,
      });
    }
    this.dirtyConversationIds.add(state.id);
  }

  /**
   * Finds the conversation this request continues, or starts a new one.
   *
   * A request qualifies as a continuation if it shares at least one leading
   * block with a known transcript; the best (longest) match wins. Anything else
   * — a fresh session, a subagent with its own system prompt, a conversation
   * whose history was compacted out from under us — becomes a new trace.
   */
  private attachToConversation(parsed: ParsedRequest, record: TransportRecord): ConversationState {
    const { history, systemFp, sessionId } = parsed;
    const fps = history.map((item) => item.fp);

    // Session identity is a precondition, not a tiebreaker.
    //
    // As a tiebreaker it was inert in exactly the case that matters. Two runs in
    // the same directory open with identical injected context — the same
    // CLAUDE.md, the same environment blocks — so a fresh session's first request
    // shares a leading prefix with the previous one. Being the only candidate, it
    // won its own comparison and the mismatch never got a say. Observed: a
    // session whose history had grown to 12 blocks absorbed a new one whose first
    // request held 3, which the rewind branch below then read as a compaction.
    let best: { state: ConversationState; score: [number, number] } | undefined;
    for (const state of this.conversations.values()) {
      if (!sameSession(state, parsed.provider, sessionId, systemFp)) continue;
      const common = commonPrefixLength(state.fps, fps);
      if (common === 0) continue;
      const score: [number, number] = [common, state.updatedAt];
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
      this.dirtyConversationIds.add(state.id);
      return state;
    }

    return this.createConversation(parsed, record);
  }

  private createConversation(parsed: ParsedRequest, record: TransportRecord): ConversationState {
    const { history, systemFp, sessionId, system, agent } = parsed;
    const id = `conv_${++this.counter}`;
    const state: ConversationState = {
      id,
      ...(parsed.provider !== 'unknown' ? { provider: parsed.provider } : {}),
      fps: [],
      producedFps: new Set(),
      sessionId,
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

    // Side calls this session made before it had a conversation to belong to.
    // Drain them before appending any node from the request that opened the
    // conversation. Their turn indexes already precede that request; keeping
    // node insertion in the same order prevents the opening request from being
    // split around them in Chat Trace.
    if (sessionId) {
      const waiting = this.pendingSideCalls.get(sessionId);
      this.pendingSideCalls.delete(sessionId);
      for (const pending of waiting ?? []) {
        this.revealSideCall(state, pending.parsed, pending.record);
        this.store.putTransport(pending.record);
      }
    }

    if (system?.trim()) {
      this.append({
        conversationId: id,
        kind: 'system',
        ts: record.timing.startedAt,
        text: system,
        systemSource: 'prompt',
        revealedByRequestId: record.id,
      });
    }

    this.dirtyConversationIds.add(id);
    return state;
  }

  private findPendingSubagentParent(): { conversationId: string; toolUseId: string } | undefined {
    // Map iteration is insertion-ordered; the newest outstanding call wins.
    let match: { conversationId: string; toolUseId: string } | undefined;
    for (const [toolUseId, info] of this.pendingToolCalls) {
      if (info.isSubagent) match = { conversationId: info.conversationId, toolUseId };
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

      // `tool_use_id` is the provider's stable identity for a call. Claude Code
      // may normalize the input before replaying the assistant block in its
      // next request (for example, stripping a local wrapper from a command or
      // adding an explicit default). In that case the content fingerprint no
      // longer matches the SSE block even though it is the same call. Treat the
      // replay fingerprint as an alias of the response-produced node so the
      // call is not duplicated and its result still binds to the original.
      if (item.kind === 'tool_call' && item.toolUseId) {
        const producedCall = this.store.findNode(
          (node) =>
            node.conversationId === state.id &&
            node.kind === 'tool_call' &&
            node.toolUseId === item.toolUseId &&
            node.producedByRequestId !== undefined,
        );
        if (producedCall) {
          state.producedFps.add(item.fp);
          continue;
        }
      }

      // Assistant-side blocks are normally already on the trace, materialised
      // live from the response stream. They only show up here when the proxy
      // started mid-conversation.
      if (state.producedFps.has(item.fp)) continue;

      if (item.kind === 'tool_result') {
        this.appendToolResult(state, item, record);
        continue;
      }

      if (item.segments) {
        for (const segment of item.segments) {
          this.append({
            conversationId: state.id,
            kind: segment.kind,
            ts: record.timing.startedAt,
            text: segment.text,
            contextTag: segment.contextTag,
            systemSource: segment.systemSource,
            sourcePath: item.sourcePath,
            revealedByRequestId: record.id,
          });
        }
        continue;
      }

      // Assistant-side history carries no model of its own, so it borrows the
      // one this request asks for — real captured data, flagged as second-hand
      // because it names a later turn's model (see `modelFromRequest`). User
      // and tool-result items are not model output and get nothing.
      const isAgentOutput =
        item.kind === 'assistant' || item.kind === 'thinking' || item.kind === 'tool_call';

      this.append({
        conversationId: state.id,
        kind: item.kind,
        ts: record.timing.startedAt,
        text: item.text,
        toolName: item.toolName,
        toolUseId: item.toolUseId,
        toolInput: item.toolInput,
        sourcePath: item.sourcePath,
        revealedByRequestId: record.id,
        model: isAgentOutput ? record.model : undefined,
        modelFromRequest: isAgentOutput && record.model !== undefined ? true : undefined,
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
      sourcePath: item.sourcePath,
      revealedByRequestId: record.id,
      durationMs,
      durationIsBatch,
    });
  }

  // -- response side --------------------------------------------------------

  onStreamFrames(record: TransportRecord, frames: SseFrame[]): void {
    const adapter = findAdapter(record);
    if (!adapter || !record.conversationId) return;
    const events = adapter.parseStreamFrames(frames);
    if (record.timing.firstTokenAt === undefined) {
      const firstOutput = events.find(
        ({ type }) => type === 'block_start' || type === 'block_delta',
      );
      if (firstOutput) record.timing.firstTokenAt = firstOutput.t;
    }
    this.applyEvents(adapter, record, events);
    this.store.touch();
  }

  onComplete(record: TransportRecord): void {
    const adapter = findAdapter(record);
    if (adapter && record.conversationId && !record.isStream) {
      this.applyEvents(adapter, record, adapter.parseResponseBody(record));
    }
    if (adapter) this.closeOpenBlocks(adapter, record);
    if (record.error && record.conversationId) {
      // The model is this exchange's own — set from the request body, and
      // overwritten by `message_start` if the response got that far. Unlike a
      // history-revealed turn it needs no `modelFromRequest` flag: the failure
      // belongs to this call, so this call's model is the right answer.
      this.append({
        conversationId: record.conversationId,
        kind: 'error',
        ts: record.timing.endedAt ?? Date.now(),
        text: record.error,
        producedByRequestId: record.id,
        model: record.model,
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
            // A side call's answer is as much an aside as its prompt: it is the
            // title, not something the model said to the user.
            ...(record.kind === 'utility' ? { sideCall: true } : {}),
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
          this.markDirty(block.node);
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
            model: record.model,
          });
          break;
      }
    }

    const conversation = this.store.getConversation(conversationId);
    if (conversation && record.model) conversation.model = record.model;
  }

  /**
   * Finalises whatever the response left open when the exchange ended.
   *
   * Claude normally sends `content_block_stop` for each block, but an aborted
   * or malformed stream may not. Leaving one open would keep its fingerprint
   * out of the transcript, and the next
   * request — replaying that same assistant turn in its history — would fail to
   * match and open a second trace for the same conversation.
   *
   * A client that hung up mid-stream lands here too, and closing that block is
   * the safer of the two outcomes rather than merely the tidier one. Some
   * runtimes keep the partial assistant text and replay it in the next
   * request's history: an unfinalised block is absent from `producedFps`, so
   * that replay would be read as new content and the same text would appear on
   * the trace twice. Closing it means the next request either matches or comes
   * up one block short — a rewind the builder already knows how to absorb.
   */
  private closeOpenBlocks(adapter: ProviderAdapter, record: TransportRecord): void {
    const stream = this.streams.get(record.id);
    if (!stream) return;
    const state = this.conversations.get(stream.conversationId);
    if (!state) return;
    const t = record.timing.endedAt ?? Date.now();
    for (const block of stream.blocks.values()) {
      if (!block.closed) this.finalizeBlock(adapter, state, block, t);
    }
  }

  private finalizeBlock(
    adapter: ProviderAdapter,
    state: ConversationState,
    block: StreamBlock,
    t: number,
  ): void {
    if (block.closed) return;
    block.closed = true;
    const node = block.node;
    node.durationMs = Math.max(0, t - node.ts);
    this.markDirty(node);

    if (node.kind === 'tool_call') {
      if (node.toolInput === undefined) {
        node.toolInput = block.buffer ? safeJsonParse(block.buffer) : {};
      }
      if (node.toolUseId) {
        const toolName = node.toolName ?? '';
        this.pendingToolCalls.set(node.toolUseId, {
          conversationId: state.id,
          toolName,
          isSubagent: adapter.isSubagentTool(toolName),
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
    this.markDirty(full);
    return full;
  }

  private markDirty(node: TraceNode): void {
    this.dirtyNodeIds.add(node.id);
    this.dirtyConversationIds.add(node.conversationId);
  }

  /**
   * Hands over everything that changed since the last call. Streaming mutates
   * a node's text on every delta, so flushing per change would mean a disk
   * write per token; the server drains once per completed exchange instead.
   */
  drain(): { nodes: TraceNode[]; conversations: { conversation: Conversation; state: ConversationState }[] } {
    const nodes: TraceNode[] = [];
    for (const id of this.dirtyNodeIds) {
      const node = this.store.findNode((candidate) => candidate.id === id);
      if (node) nodes.push(node);
    }
    const conversations: { conversation: Conversation; state: ConversationState }[] = [];
    for (const id of this.dirtyConversationIds) {
      const conversation = this.store.getConversation(id);
      const state = this.conversations.get(id);
      if (conversation && state) conversations.push({ conversation, state });
    }
    this.dirtyNodeIds.clear();
    this.dirtyConversationIds.clear();
    return { nodes, conversations };
  }

  /**
   * Drops reconstruction state for conversations that retention has evicted.
   *
   * Without this the builder keeps matching new requests against a conversation
   * the store no longer holds: the request gets a conversationId that resolves
   * to nothing, so its transport row is written while its conversation row is
   * not, and the row can never be evicted afterwards. Forgetting makes the next
   * request from that session open a fresh trace — the honest outcome, since
   * its history is genuinely gone.
   */
  forget(conversationIds: readonly string[]): void {
    for (const id of conversationIds) {
      this.conversations.delete(id);
      this.dirtyConversationIds.delete(id);
      for (const [requestId, stream] of this.streams) {
        if (stream.conversationId === id) this.streams.delete(requestId);
      }
      for (const [toolUseId, info] of this.pendingToolCalls) {
        if (info.conversationId === id) this.pendingToolCalls.delete(toolUseId);
      }
    }
  }

  /** Clears every correlation cache after the user explicitly clears traces. */
  reset(): void {
    this.conversations.clear();
    this.streams.clear();
    this.pendingToolCalls.clear();
    this.pendingSideCalls.clear();
    this.dirtyNodeIds.clear();
    this.dirtyConversationIds.clear();
    this.counter = 0;
  }

  /**
   * Rehydrates reconstruction state after a restart, so the next request from a
   * still-running agent extends its existing trace rather than opening a new one.
   *
   * Pending tool calls are derived from the nodes rather than stored: a
   * tool_call whose tool_use_id has no matching tool_result is by definition
   * still outstanding.
   */
  restore(
    conversations: { conversation: Conversation; state: ConversationState }[],
    nodes: TraceNode[],
  ): void {
    for (const { state } of conversations) this.conversations.set(state.id, state);

    const resolved = new Set(
      nodes.filter((n) => n.kind === 'tool_result' && n.toolUseId).map((n) => n.toolUseId),
    );
    for (const node of nodes) {
      if (node.kind === 'tool_call' && node.toolUseId && !resolved.has(node.toolUseId)) {
        const toolName = node.toolName ?? '';
        this.pendingToolCalls.set(node.toolUseId, {
          conversationId: node.conversationId,
          toolName,
          isSubagent: isSubagentTool(toolName),
        });
      }
    }

    // Ids are `conv_N` / `node_N` off one counter; resume past the high-water
    // mark so restored and fresh ids can never collide.
    const ids = [...conversations.map((c) => c.conversation.id), ...nodes.map((n) => n.id)];
    for (const id of ids) {
      const n = Number.parseInt(id.slice(id.indexOf('_') + 1), 10);
      if (Number.isFinite(n) && n > this.counter) this.counter = n;
    }
  }
}

/** Lexicographic compare of the candidate ranking tuple. */
/**
 * Whether a candidate conversation belongs to the same agent run as the request.
 *
 * Both signals are required, because each covers the other's blind spot:
 *
 *   - The **run id** (`x-claude-code-session-id`, surfaced by the adapter) is the
 *     runtime's own answer to this exact question. It separates two runs that
 *     produce a byte-identical system prompt, which a fingerprint cannot.
 *   - The **system prompt** separates a subagent from its parent. A `Task`
 *     subagent runs inside the same session and so carries the same run id, but
 *     it is given its own prompt — without this it could be absorbed into the
 *     parent whenever their opening blocks happen to agree.
 *
 * The run id is only enforced when both sides have one, so agents that send no
 * such header (and conversations restored from before it was recorded) still
 * match on the prompt alone.
 *
 * The cost is that a system prompt changing mid-run would split the trace. That
 * is the safe direction to fail — two traces instead of one corrupted one — and
 * it is not observed: Claude Code's environment block is documented as a
 * start-of-session snapshot, and it held constant across every request of every
 * captured session.
 */
function sameSession(
  state: ConversationState,
  provider: ProviderId,
  sessionId: string | undefined,
  systemFp: string,
): boolean {
  if (state.provider && state.provider !== provider) return false;
  if (state.sessionId && sessionId && state.sessionId !== sessionId) return false;
  return state.systemFp === systemFp;
}

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
 * The title is the first thing the human actually typed.
 *
 * Injected context is separated structurally, upstream: the adapter has already
 * split `<tag>…</tag>` wrappers into `context` segments, so taking the `user`
 * segments skips them whatever the runtime happens to call its tags. A message
 * that is nothing but injected context yields no user segment at all and is
 * passed over rather than falling back to its raw text — titling a trace with
 * the contents of a reminder is worse than looking at the next message.
 */
function deriveTitle(history: HistoryItem[]): string | undefined {
  for (const item of history) {
    if (item.kind !== 'user') continue;
    const userText = item.segments
      ? item.segments
          .filter(({ kind }) => kind === 'user')
          .map(({ text }) => text)
          .join(' ')
      : item.text;
    if (!userText) continue;
    // Any tags left inside a user segment are stripped generically — this is
    // shape, not vocabulary.
    const cleaned = userText
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
