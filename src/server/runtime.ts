import type { Store } from '../core/store.js';
import type { TraceBuilder } from '../core/trace-builder.js';
import type { SseFrame, TransportRecord } from '../core/types.js';
import type { Persistence } from './persistence.js';
import type { ProxyHooks } from './proxy.js';

export interface CaptureRuntimeOptions {
  store: Store;
  builder: TraceBuilder;
  persistence?: Persistence;
}

/**
 * Owns the lifecycle shared by proxy callbacks, Clear, and retention.
 * A generation boundary prevents requests that were in flight during Clear
 * from repopulating memory or disk after the user sees an empty UI.
 */
export class CaptureRuntime {
  readonly hooks: ProxyHooks;

  private generation = 0;
  private readonly requestGeneration = new WeakMap<TransportRecord, number>();
  private readonly activeConversationByRequest = new WeakMap<TransportRecord, string>();
  private readonly activeConversationCounts = new Map<string, number>();
  private readonly completedRequests = new WeakSet<TransportRecord>();

  constructor(private readonly options: CaptureRuntimeOptions) {
    this.hooks = {
      onRequestStart: (record) => this.onRequestStart(record),
      onRequestBody: (record) => this.onRequestBody(record),
      onResponseStart: (record) => this.onResponseStart(record),
      onStreamFrames: (record, frames) => this.onStreamFrames(record, frames),
      onComplete: (record) => this.onComplete(record),
    };
  }

  clear(): void {
    this.generation += 1;
    this.activeConversationCounts.clear();
    this.options.builder.reset();
    this.options.store.clear();
    this.options.persistence?.clear();
  }

  private onRequestStart(record: TransportRecord): void {
    this.requestGeneration.set(record, this.generation);
  }

  private onRequestBody(record: TransportRecord): void {
    if (!this.isCurrent(record)) return;
    this.options.builder.onRequestBody(record);
    if (!record.conversationId) return;
    this.activeConversationByRequest.set(record, record.conversationId);
    this.activeConversationCounts.set(
      record.conversationId,
      (this.activeConversationCounts.get(record.conversationId) ?? 0) + 1,
    );
  }

  private onResponseStart(record: TransportRecord): void {
    if (!this.isCurrent(record)) return;
    this.options.store.putTransport(record);
    this.options.store.touch();
  }

  private onStreamFrames(record: TransportRecord, frames: SseFrame[]): void {
    if (!this.isCurrent(record)) return;
    this.options.builder.onStreamFrames(record, frames);
  }

  private onComplete(record: TransportRecord): void {
    if (this.completedRequests.has(record)) return;
    this.completedRequests.add(record);
    if (!this.isCurrent(record)) return;

    this.options.builder.onComplete(record);
    this.persistAndOffload(record);
    this.deactivate(record);
    this.options.store.touch();
  }

  private persistAndOffload(record: TransportRecord): void {
    const persistence = this.options.persistence;
    if (!persistence) return;
    persistence.saveTransport(record);

    const { nodes, conversations } = this.options.builder.drain();
    for (const node of nodes) persistence.saveNode(node);
    for (const { conversation, state } of conversations) {
      persistence.saveConversation(conversation, state);
    }

    record.requestBodyRaw = undefined;
    record.requestBody = undefined;
    record.responseBodyRaw = undefined;
    record.responseBody = undefined;
    record.sseFrames = [];
    record.bodiesOffloaded = true;

    const protectedIds = new Set(this.activeConversationCounts.keys());
    const evicted = persistence.sweep(protectedIds);
    for (const id of evicted) this.options.store.dropConversation(id);
    this.options.builder.forget(evicted);
  }

  private deactivate(record: TransportRecord): void {
    const conversationId = this.activeConversationByRequest.get(record);
    if (!conversationId) return;
    const next = (this.activeConversationCounts.get(conversationId) ?? 1) - 1;
    if (next > 0) this.activeConversationCounts.set(conversationId, next);
    else this.activeConversationCounts.delete(conversationId);
  }

  private isCurrent(record: TransportRecord): boolean {
    return this.requestGeneration.get(record) === this.generation;
  }
}
