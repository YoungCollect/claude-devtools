import type {
  Conversation,
  StateSnapshot,
  TraceNode,
  TransportRecord,
  TransportSummary,
} from './types.js';

/**
 * In-memory store for one devtools session.
 *
 * Everything lives in memory on purpose: this is a local debugging tool, the
 * data is highly sensitive (auth headers, full source code in prompts), and
 * "restart the proxy to get a clean slate" is the behaviour a devtool wants.
 *
 * Mutations bump `rev` and notify subscribers. The UI reacts by refetching the
 * (small) summary snapshot rather than applying patches — with a single local
 * agent the traffic is tiny, and it removes a whole class of sync bugs.
 */
export class Store {
  private rev = 0;
  private readonly transport = new Map<string, TransportRecord>();
  private readonly transportOrder: string[] = [];
  private readonly conversations = new Map<string, Conversation>();
  private readonly nodesByConversation = new Map<string, TraceNode[]>();
  private readonly listeners = new Set<(rev: number) => void>();

  constructor(private readonly maxRequests = 1000) {}

  // -- subscriptions --------------------------------------------------------

  subscribe(fn: (rev: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Call after any mutation. Cheap enough to invoke per SSE frame. */
  touch(): void {
    this.rev += 1;
    for (const fn of this.listeners) fn(this.rev);
  }

  getRev(): number {
    return this.rev;
  }

  // -- transport ------------------------------------------------------------

  putTransport(record: TransportRecord): void {
    if (!this.transport.has(record.id)) {
      this.transportOrder.push(record.id);
      this.evictIfNeeded();
    }
    this.transport.set(record.id, record);
  }

  getTransport(id: string): TransportRecord | undefined {
    return this.transport.get(id);
  }

  listTransport(): TransportRecord[] {
    return this.transportOrder
      .map((id) => this.transport.get(id))
      .filter((r): r is TransportRecord => r !== undefined);
  }

  private evictIfNeeded(): void {
    while (this.transportOrder.length > this.maxRequests) {
      const oldest = this.transportOrder.shift();
      if (oldest) this.transport.delete(oldest);
    }
  }

  // -- conversations & nodes ------------------------------------------------

  putConversation(conversation: Conversation): void {
    this.conversations.set(conversation.id, conversation);
    if (!this.nodesByConversation.has(conversation.id)) {
      this.nodesByConversation.set(conversation.id, []);
    }
  }

  getConversation(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  listConversations(): Conversation[] {
    return [...this.conversations.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  appendNode(node: TraceNode): void {
    const nodes = this.nodesByConversation.get(node.conversationId);
    if (nodes) {
      nodes.push(node);
    } else {
      this.nodesByConversation.set(node.conversationId, [node]);
    }
    const conversation = this.conversations.get(node.conversationId);
    if (conversation) {
      conversation.nodeCount += 1;
      conversation.updatedAt = Math.max(conversation.updatedAt, node.ts);
    }
  }

  getNodes(conversationId: string): TraceNode[] {
    return this.nodesByConversation.get(conversationId) ?? [];
  }

  /** Finds a node across all conversations — used to resolve tool_use_id links. */
  findNode(predicate: (node: TraceNode) => boolean): TraceNode | undefined {
    for (const nodes of this.nodesByConversation.values()) {
      // Reverse: correlations almost always target something recent.
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (node && predicate(node)) return node;
      }
    }
    return undefined;
  }

  /** Removes one conversation and its nodes — used when retention evicts it. */
  dropConversation(id: string): void {
    this.conversations.delete(id);
    this.nodesByConversation.delete(id);
    // Collect first, then rewrite the order list once. Splicing per removal
    // meant an indexOf scan for every evicted request, which at the default cap
    // of 5000 is quadratic work on a path retention runs routinely.
    const removed = new Set<string>();
    for (const [recordId, record] of this.transport) {
      if (record.conversationId === id) removed.add(recordId);
    }
    if (removed.size === 0) return;
    for (const recordId of removed) this.transport.delete(recordId);
    const kept = this.transportOrder.filter((recordId) => !removed.has(recordId));
    this.transportOrder.length = 0;
    this.transportOrder.push(...kept);
  }

  clear(): void {
    this.transport.clear();
    this.transportOrder.length = 0;
    this.conversations.clear();
    this.nodesByConversation.clear();
    this.touch();
  }

  // -- projections ----------------------------------------------------------

  snapshot(): StateSnapshot {
    return {
      rev: this.rev,
      conversations: this.listConversations(),
      transport: this.listTransport().map(summarizeTransport),
    };
  }
}

export function summarizeTransport(record: TransportRecord): TransportSummary {
  const { startedAt, ttfbAt, endedAt } = record.timing;
  return {
    id: record.id,
    provider: record.provider,
    kind: record.kind,
    method: record.method,
    path: record.path,
    status: record.status,
    model: record.model,
    isStream: record.isStream,
    startedAt,
    durationMs: endedAt !== undefined ? endedAt - startedAt : undefined,
    ttfbMs: ttfbAt !== undefined ? ttfbAt - startedAt : undefined,
    requestBytes: record.requestBytes,
    responseBytes: record.responseBytes,
    usage: record.usage,
    conversationId: record.conversationId,
    turnIndex: record.turnIndex,
    error: record.error,
  };
}
