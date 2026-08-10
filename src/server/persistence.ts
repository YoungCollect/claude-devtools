import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { redactHeaders } from '../core/redact.js';
import type { ConversationState } from '../core/trace-builder.js';
import type { Conversation, TraceNode, TransportRecord } from '../core/types.js';

/**
 * The heavy half of a `TransportRecord`, kept on disk and loaded only when the
 * Inspector actually opens a request.
 *
 * This split is the whole point of persisting. A single Claude Code turn ships
 * ~233 kB of request body — the entire transcript, resent every turn — and the
 * in-memory record held both the raw string and its parsed object. Holding a
 * working session's worth of that costs hundreds of megabytes; holding only the
 * metadata costs kilobytes.
 */
export interface TransportBodies {
  requestBodyRaw?: string;
  requestBody?: unknown;
  responseBodyRaw?: string;
  responseBody?: unknown;
  sseFrames: TransportRecord['sseFrames'];
}

/** Everything needed to resume trace reconstruction after a restart. */
export interface PersistedConversation {
  conversation: Conversation;
  state: ConversationState;
}

export interface LoadedState {
  conversations: PersistedConversation[];
  nodes: TraceNode[];
  transport: TransportRecord[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  updated_at    INTEGER NOT NULL,
  conversation  TEXT NOT NULL,
  builder_state TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_updated ON conversations(updated_at);

CREATE TABLE IF NOT EXISTS nodes (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  node            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS nodes_conversation ON nodes(conversation_id, seq);

CREATE TABLE IF NOT EXISTS transport (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT,
  started_at      INTEGER NOT NULL,
  meta            TEXT NOT NULL,
  bodies          TEXT,
  bytes           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transport_started ON transport(started_at);
CREATE INDEX IF NOT EXISTS transport_conversation ON transport(conversation_id);
`;

export interface PersistenceOptions {
  file: string;
  /** Total size of stored bodies before the oldest conversations are dropped. */
  maxBytes: number;
}

export class Persistence {
  private readonly db: DatabaseSync;
  private nodeSeq = 0;
  /** Running total of stored body bytes, so the cap needs no SUM() per write. */
  private storedBytes = 0;

  constructor(private readonly options: PersistenceOptions) {
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(options.file);
    // WAL keeps the streaming write path from blocking reads by the UI.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    // Must be set before the schema exists for a new file; lets deleted pages
    // return to the OS instead of leaving the file permanently inflated.
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    this.db.exec(SCHEMA);
    this.repairNodeSequences();
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS nodes_seq_unique ON nodes(seq)');
    this.nodeSeq = this.nextNodeSequence();
    this.storedBytes = this.sumBytes();
    this.restrictPermissions();
  }

  /** Owner-only: this file holds whole source files from prompts. */
  private restrictPermissions(): void {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        chmodSync(`${this.options.file}${suffix}`, 0o600);
      } catch {
        // -wal/-shm may not exist yet; the next write recreates them under the
        // same umask and the directory is already 0700.
      }
    }
  }

  // -- writes ---------------------------------------------------------------

  saveConversation(conversation: Conversation, state: ConversationState): void {
    this.db
      .prepare(
        `INSERT INTO conversations (id, updated_at, conversation, builder_state)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           updated_at = excluded.updated_at,
           conversation = excluded.conversation,
           builder_state = excluded.builder_state`,
      )
      .run(
        conversation.id,
        conversation.updatedAt,
        JSON.stringify(conversation),
        JSON.stringify({ ...state, producedFps: [...state.producedFps] }),
      );
  }

  saveNode(node: TraceNode): void {
    const serialized = JSON.stringify(node);
    const exists = this.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(node.id);
    if (exists) {
      this.db
        .prepare('UPDATE nodes SET conversation_id = ?, node = ? WHERE id = ?')
        .run(node.conversationId, serialized, node.id);
      return;
    }
    this.db
      .prepare('INSERT INTO nodes (id, conversation_id, seq, node) VALUES (?, ?, ?, ?)')
      .run(node.id, node.conversationId, this.nodeSeq++, serialized);
  }

  /**
   * Writes a completed exchange and returns the bodies that were persisted, so
   * the caller can drop them from memory.
   *
   * Credentials are masked on the way in: a trace file that outlives the
   * session it came from must not carry a live token. The in-memory record
   * keeps the real header, which is what the Inspector's reveal toggle reads.
   */
  saveTransport(record: TransportRecord): void {
    const bodies: TransportBodies = {
      requestBodyRaw: record.requestBodyRaw,
      responseBodyRaw: record.responseBodyRaw,
      sseFrames: record.sseFrames,
    };
    const bodiesJson = JSON.stringify(bodies);
    const meta = JSON.stringify({
      ...record,
      requestHeaders: redactHeaders(record.requestHeaders, false),
      responseHeaders: record.responseHeaders
        ? redactHeaders(record.responseHeaders, false)
        : undefined,
      requestBodyRaw: undefined,
      requestBody: undefined,
      responseBodyRaw: undefined,
      responseBody: undefined,
      sseFrames: [],
    });

    // A re-save replaces the row, so account for the delta rather than adding twice.
    const previous = this.db.prepare('SELECT bytes FROM transport WHERE id = ?').get(record.id) as
      | { bytes: number }
      | undefined;

    this.db
      .prepare(
        `INSERT INTO transport (id, conversation_id, started_at, meta, bodies, bytes)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           meta = excluded.meta,
           bodies = excluded.bodies,
           bytes = excluded.bytes`,
      )
      .run(
        record.id,
        record.conversationId ?? null,
        record.timing.startedAt,
        meta,
        bodiesJson,
        Buffer.byteLength(bodiesJson),
      );

    this.storedBytes += Buffer.byteLength(bodiesJson) - (previous?.bytes ?? 0);
  }

  // -- reads ----------------------------------------------------------------

  /** Loads the bodies for one request. Returns undefined once evicted. */
  loadBodies(id: string): TransportBodies | undefined {
    const row = this.db.prepare('SELECT bodies FROM transport WHERE id = ?').get(id) as
      | { bodies: string | null }
      | undefined;
    if (!row?.bodies) return undefined;
    const bodies = JSON.parse(row.bodies) as TransportBodies;
    // Parsed forms are derived on read rather than stored twice.
    bodies.requestBody = tryParse(bodies.requestBodyRaw);
    bodies.responseBody = tryParse(bodies.responseBodyRaw);
    return bodies;
  }

  loadAll(): LoadedState {
    const conversationRows = this.db
      .prepare('SELECT conversation, builder_state FROM conversations ORDER BY updated_at')
      .all() as { conversation: string; builder_state: string }[];

    const conversations = conversationRows.map((row) => {
      const raw = JSON.parse(row.builder_state) as ConversationState & { producedFps: string[] };
      return {
        conversation: JSON.parse(row.conversation) as Conversation,
        state: { ...raw, producedFps: new Set(raw.producedFps) } as ConversationState,
      };
    });

    const nodeRows = this.db.prepare('SELECT node FROM nodes ORDER BY seq').all() as {
      node: string;
    }[];
    const nodes = nodeRows.map((row) => JSON.parse(row.node) as TraceNode);

    const transportRows = this.db
      .prepare('SELECT meta FROM transport ORDER BY started_at')
      .all() as { meta: string }[];
    const transport = transportRows.map((row) => {
      const record = JSON.parse(row.meta) as TransportRecord;
      record.sseFrames = [];
      return record;
    });

    return { conversations, nodes, transport };
  }

  // -- retention ------------------------------------------------------------

  /**
   * Drops whole inactive conversations, oldest first, until stored bodies fit
   * the cap. If only protected conversations remain, their oldest bodies are
   * trimmed while trace metadata stays intact.
   *
   * Accounting is by bytes, not by row count: one request can be 200 kB and
   * another 400 bytes, so a count-based cap says nothing about actual size.
   * Returns the conversation ids removed so the in-memory index can follow.
   */
  sweep(protectedConversationIds: ReadonlySet<string> = new Set()): string[] {
    if (this.storedBytes <= this.options.maxBytes) return [];

    const evicted: string[] = [];
    let vacuumNeeded = false;
    while (this.storedBytes > this.options.maxBytes) {
      const candidates = this.db
        .prepare('SELECT id FROM conversations ORDER BY updated_at')
        .all() as { id: string }[];
      const oldest = candidates.find(({ id }) => !protectedConversationIds.has(id));

      if (oldest) {
        this.db.prepare('DELETE FROM transport WHERE conversation_id = ?').run(oldest.id);
        this.db.prepare('DELETE FROM nodes WHERE conversation_id = ?').run(oldest.id);
        this.db.prepare('DELETE FROM conversations WHERE id = ?').run(oldest.id);
        evicted.push(oldest.id);
        vacuumNeeded = true;
        this.storedBytes = this.sumBytes();
        continue;
      }

      // What remains is transport with no conversation to hang from: utility
      // traffic that never joined one, plus anything left dangling by an
      // earlier eviction. Both are unreachable from the UI, so both go.
      const orphanIds = this.db
        .prepare(
          `SELECT t.id, t.conversation_id FROM transport t
           WHERE t.conversation_id IS NULL
              OR NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id)
           ORDER BY t.started_at`,
        )
        .all() as { id: string; conversation_id: string | null }[];
      const removableOrphans = orphanIds
        .filter(
          ({ conversation_id }) =>
            conversation_id === null || !protectedConversationIds.has(conversation_id),
        )
        .slice(0, 200);
      if (removableOrphans.length > 0) {
        const remove = this.db.prepare('DELETE FROM transport WHERE id = ?');
        for (const { id } of removableOrphans) remove.run(id);
        vacuumNeeded = true;
        this.storedBytes = this.sumBytes();
        continue;
      }

      // Only protected conversations remain. Preserve their trace metadata but
      // release the oldest heavy body so the configured byte cap stays real.
      const trimmed = this.db
        .prepare(
          `UPDATE transport SET bodies = NULL, bytes = 0
           WHERE id = (
             SELECT id FROM transport WHERE bytes > 0 ORDER BY started_at LIMIT 1
           )`,
        )
        .run();
      if (trimmed.changes === 0) break;
      vacuumNeeded = true;
      this.storedBytes = this.sumBytes();
    }

    if (vacuumNeeded) this.db.exec('PRAGMA incremental_vacuum');
    return evicted;
  }

  totalBytes(): number {
    return this.storedBytes;
  }

  /** Permanently removes one conversation and every row owned by it. */
  deleteConversation(id: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM transport WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM nodes WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.storedBytes = this.sumBytes();
    this.db.exec('PRAGMA incremental_vacuum');
  }

  private sumBytes(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM transport').get() as
      | { total: number }
      | undefined;
    return row?.total ?? 0;
  }

  private nextNodeSequence(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM nodes').get() as
      | { next: number }
      | undefined;
    return row?.next ?? 0;
  }

  /** Repairs sequence gaps/duplicates written by versions before 0.0.1. */
  private repairNodeSequences(): void {
    const stats = this.db
      .prepare(
        `SELECT COUNT(*) AS count,
                COUNT(DISTINCT seq) AS distinct_count,
                COALESCE(MIN(seq), 0) AS min_seq,
                COALESCE(MAX(seq), -1) AS max_seq
         FROM nodes`,
      )
      .get() as {
      count: number;
      distinct_count: number;
      min_seq: number;
      max_seq: number;
    };
    const contiguous =
      stats.count === 0 ||
      (stats.distinct_count === stats.count &&
        stats.min_seq === 0 &&
        stats.max_seq === stats.count - 1);
    if (contiguous) return;

    const offset = stats.max_seq + stats.count + 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Move existing values out of the target range first. This also works on
      // later starts after the unique sequence index has been created.
      this.db.prepare('UPDATE nodes SET seq = seq + ?').run(offset);
      this.db.exec(`
        WITH ordered AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY seq, rowid) - 1 AS new_seq
          FROM nodes
        )
        UPDATE nodes
        SET seq = (SELECT new_seq FROM ordered WHERE ordered.id = nodes.id)
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  clear(): void {
    this.db.exec('DELETE FROM transport; DELETE FROM nodes; DELETE FROM conversations;');
    this.db.exec('PRAGMA incremental_vacuum');
    this.storedBytes = 0;
    this.nodeSeq = 0;
  }

  close(): void {
    this.db.close();
  }
}

function tryParse(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
