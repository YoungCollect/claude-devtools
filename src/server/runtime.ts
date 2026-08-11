import type { Store } from '../core/store.js';
import type { TraceBuilder } from '../core/trace-builder.js';
import type { SseFrame, TransportRecord } from '../core/types.js';
import type { Persistence } from './persistence.js';
import type { ProxyHooks } from './proxy.js';

export interface CaptureRuntimeOptions {
  store: Store;
  builder: TraceBuilder;
  persistence?: Persistence;
  /**
   * Byte budget for bodies held in memory when there is no database to move
   * them to. Ignored with persistence on, where bodies leave memory as soon as
   * the exchange finishes.
   */
  maxResidentBodyBytes?: number;
}

/** Default resident budget for `--no-persist`, matching the on-disk default. */
const DEFAULT_RESIDENT_BODY_BYTES = 1024 * 1024 * 1024;

/** Rough resident cost of one record's bodies. Character counts are close
 *  enough to compare against a budget, and free to compute. */
function bodyBytes(record: TransportRecord): number {
  let total = (record.requestBodyRaw?.length ?? 0) + (record.responseBodyRaw?.length ?? 0);
  for (const frame of record.sseFrames) total += frame.raw.length;
  return total;
}

function dropBodies(record: TransportRecord): void {
  record.requestBodyRaw = undefined;
  record.requestBody = undefined;
  record.responseBodyRaw = undefined;
  record.responseBody = undefined;
  record.sseFrames = [];
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
  /** Prevents a deleted conversation's in-flight callbacks from restoring it. */
  private readonly deletedConversationIds = new Set<string>();
  /** Bodies still held in memory, oldest first. Only used without persistence. */
  private readonly residentBodies: { record: TransportRecord; bytes: number }[] = [];
  private residentBytes = 0;

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
    this.deletedConversationIds.clear();
    this.releaseResident(() => false);
    this.options.builder.reset();
    this.options.store.clear();
    this.options.persistence?.clear();
  }

  deleteConversation(id: string): boolean {
    if (!this.options.store.getConversation(id)) return false;
    // Delete durable state first: a disk failure must not leave memory claiming
    // the operation succeeded while the chat returns after restart.
    this.options.persistence?.deleteConversation(id);
    this.deletedConversationIds.add(id);
    this.activeConversationCounts.delete(id);
    this.options.builder.forget([id]);
    this.releaseResident((record) => record.conversationId !== id);
    this.options.store.dropConversation(id);
    this.options.store.touch();
    return true;
  }

  /**
   * Gives one conversation a human-chosen title.
   *
   * The derived title is only ever computed when a conversation is created, so
   * a rename survives every later request on the same trace. Disk goes first,
   * for the same reason delete does: memory must not show a name that a restart
   * would throw away.
   */
  renameConversation(id: string, title: string): boolean {
    const conversation = this.options.store.getConversation(id);
    if (!conversation) return false;
    this.options.persistence?.renameConversation(id, title);
    conversation.title = title;
    this.options.store.touch();
    return true;
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

  /**
   * Ends an exchange's lifecycle: hand the heavy half to disk, drop it from
   * memory, and let retention run.
   *
   * Every step here runs with or without persistence. `--no-persist` means
   * "nothing reaches disk", not "nothing is cleaned up" — when the offload and
   * the drain lived behind the persistence check, that mode kept every raw and
   * parsed body resident for the life of the process, bounded only by the
   * in-memory request cap, and let the builder's dirty sets grow without limit.
   * That is the unbounded growth the on-disk split exists to prevent.
   */
  private persistAndOffload(record: TransportRecord): void {
    const persistence = this.options.persistence;
    persistence?.saveTransport(record);

    const { nodes, conversations } = this.options.builder.drain();
    persistence?.transaction(() => {
      for (const node of nodes) persistence.saveNode(node);
      for (const { conversation, state } of conversations) {
        persistence.saveConversation(conversation, state);
      }
    });

    if (!persistence) {
      this.holdBodiesInMemory(record);
      return;
    }

    dropBodies(record);
    record.bodiesOffloaded = true;

    const protectedIds = new Set(this.activeConversationCounts.keys());
    const evicted = persistence.sweep(protectedIds);
    for (const id of evicted) this.options.store.dropConversation(id);
    this.options.builder.forget(evicted);
  }

  /**
   * Retention for `--no-persist`: keep recent bodies readable, bound the total.
   *
   * Dropping them outright would bound memory and gut the tool — inspecting a
   * payload is the reason it exists, and with no database there is nothing to
   * read one back from. Keeping them all is what made this mode grow without
   * limit. So the newest bodies stay resident under the same byte budget the
   * database enforces, and the oldest are released once it is exceeded.
   *
   * The most recent exchange is always kept, however large, so the request you
   * just watched arrive is never the one you cannot open.
   */
  private holdBodiesInMemory(record: TransportRecord): void {
    const budget = this.options.maxResidentBodyBytes ?? DEFAULT_RESIDENT_BODY_BYTES;
    this.residentBodies.push({ record, bytes: bodyBytes(record) });
    this.residentBytes += this.residentBodies[this.residentBodies.length - 1]?.bytes ?? 0;

    while (this.residentBytes > budget && this.residentBodies.length > 1) {
      const oldest = this.residentBodies.shift();
      if (!oldest) break;
      dropBodies(oldest.record);
      this.residentBytes -= oldest.bytes;
    }
  }

  /** Forgets resident bodies for records that are no longer reachable. */
  private releaseResident(keep: (record: TransportRecord) => boolean): void {
    const kept: typeof this.residentBodies = [];
    let bytes = 0;
    for (const entry of this.residentBodies) {
      if (keep(entry.record)) {
        kept.push(entry);
        bytes += entry.bytes;
      } else {
        dropBodies(entry.record);
      }
    }
    this.residentBodies.length = 0;
    this.residentBodies.push(...kept);
    this.residentBytes = bytes;
  }

  private deactivate(record: TransportRecord): void {
    const conversationId = this.activeConversationByRequest.get(record);
    if (!conversationId) return;
    const next = (this.activeConversationCounts.get(conversationId) ?? 1) - 1;
    if (next > 0) this.activeConversationCounts.set(conversationId, next);
    else this.activeConversationCounts.delete(conversationId);
  }

  private isCurrent(record: TransportRecord): boolean {
    return (
      this.requestGeneration.get(record) === this.generation &&
      (!record.conversationId || !this.deletedConversationIds.has(record.conversationId))
    );
  }
}
