/**
 * Bakes a captured trace database into the static JSON a GitHub Pages preview
 * serves in place of the local API.
 *
 * The live API answers four reads: config, state, a conversation's nodes, and
 * one transport record. This writes the same four shapes to disk, running the
 * request through `presentRecord` so the preview and the running tool cannot
 * disagree about what an exchange looks like.
 *
 * The database is opened read-only. It is a committed repository artifact, and
 * `Persistence` would migrate it on open — repairing sequences, adding indexes,
 * leaving `-wal`/`-shm` beside it — which is the wrong thing to do to a file
 * that is checked in and read in CI.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { summarizeTransport } from '../core/store.js';
import type { Conversation, StateSnapshot, TraceNode, TransportRecord } from '../core/types.js';
import { presentRecord } from '../server/transport-view.js';
import {
  PREVIEW_INDEX_FILE,
  previewNodesFile,
  previewTransportFile,
  type PreviewIndex,
} from './paths.js';
import { assertNoCredentials } from './scrub.js';

export interface BuildPreviewOptions {
  /** SQLite file captured by `claude-devtools --db <file>`. */
  dbFile: string;
  /** Directory the `preview-data/` tree is written into. Cleared first. */
  outDir: string;
  /**
   * Placeholder shown in the UI's setup panel. The preview has no proxy, and
   * printing a real loopback command a visitor cannot use would be a lie.
   */
  proxyUrl?: string;
  upstream?: string;
}

export interface BuildPreviewResult {
  conversations: number;
  nodes: number;
  transport: number;
  bytes: number;
}

/**
 * Both halves of a stored transport row: metadata, and the offloaded bodies.
 *
 * A type alias rather than an interface so it stays assignable from
 * `node:sqlite`'s `Record<string, SQLOutputValue>` row shape — interfaces get no
 * implicit index signature, and the cast on the query result would not compile.
 */
type TransportRow = {
  meta: string;
  bodies: string | null;
};

export function buildPreview(options: BuildPreviewOptions): BuildPreviewResult {
  const dbFile = resolve(options.dbFile);
  const outDir = resolve(options.outDir);
  const db = new DatabaseSync(dbFile, { readOnly: true });

  try {
    const conversations = readConversations(db);
    const nodesByConversation = readNodes(db);
    const transportRows = readTransport(db);

    // Same projection the live store publishes, so the preview's Network view
    // and conversation list are sorted and summarised identically.
    const state: StateSnapshot = {
      rev: 0,
      conversations: [...conversations].sort((a, b) => a.startedAt - b.startedAt),
      transport: transportRows.map(({ record }) => summarizeTransport(record)),
      activeRequests: 0,
    };

    rmSync(outDir, { recursive: true, force: true });

    let bytes = 0;
    const write = (relativePath: string, value: unknown): void => {
      const file = join(outDir, relativePath);
      mkdirSync(dirname(file), { recursive: true });
      const json = JSON.stringify(value);
      assertNoCredentials(json, relativePath);
      writeFileSync(file, json);
      bytes += Buffer.byteLength(json);
    };

    const index: PreviewIndex = {
      generatedAt: new Date().toISOString(),
      source: basename(dbFile),
      config: {
        proxyUrl: options.proxyUrl ?? 'http://127.0.0.1:4141',
        upstream: options.upstream ?? 'https://api.anthropic.com',
        uiPort: 4142,
      },
      state,
    };
    write(PREVIEW_INDEX_FILE, index);

    // Every conversation gets a file, including the ones whose nodes were
    // evicted: the UI asks for nodes as soon as a conversation is selected, and
    // a 404 there would read as a broken preview rather than an empty trace.
    for (const conversation of conversations) {
      write(previewNodesFile(conversation.id), {
        nodes: nodesByConversation.get(conversation.id) ?? [],
      });
    }

    for (const { record } of transportRows) {
      write(previewTransportFile(record.id), { record: presentRecord(record) });
    }

    return {
      conversations: conversations.length,
      nodes: [...nodesByConversation.values()].reduce((total, list) => total + list.length, 0),
      transport: transportRows.length,
      bytes,
    };
  } finally {
    db.close();
  }
}

function readConversations(db: DatabaseSync): Conversation[] {
  const rows = db
    .prepare('SELECT conversation FROM conversations ORDER BY updated_at')
    .all() as { conversation: string }[];
  return rows.map((row) => JSON.parse(row.conversation) as Conversation);
}

function readNodes(db: DatabaseSync): Map<string, TraceNode[]> {
  const rows = db.prepare('SELECT node FROM nodes ORDER BY seq').all() as { node: string }[];
  const byConversation = new Map<string, TraceNode[]>();
  for (const row of rows) {
    const node = JSON.parse(row.node) as TraceNode;
    const list = byConversation.get(node.conversationId);
    if (list) list.push(node);
    else byConversation.set(node.conversationId, [node]);
  }
  return byConversation;
}

/**
 * Rebuilds whole records by folding the offloaded bodies back into the
 * metadata — the disk equivalent of what `hydrate` does for a live request.
 *
 * A row whose bodies retention already released still yields a record; only its
 * heavy fields are missing, which is exactly how the running tool renders it.
 */
function readTransport(db: DatabaseSync): { record: TransportRecord }[] {
  const rows = db
    .prepare('SELECT meta, bodies FROM transport ORDER BY started_at')
    .all() as TransportRow[];

  return rows.map((row) => {
    const record = JSON.parse(row.meta) as TransportRecord;
    record.sseFrames = [];
    if (!row.bodies) return { record };

    const bodies = JSON.parse(row.bodies) as {
      requestBodyRaw?: string;
      responseBodyRaw?: string;
      sseFrames?: TransportRecord['sseFrames'];
    };
    return {
      record: {
        ...record,
        // Baked in full: a static host cannot answer a second request for the
        // bodies later, so `bodiesOffloaded` would leave the Inspector empty.
        bodiesOffloaded: false,
        requestBodyRaw: bodies.requestBodyRaw,
        requestBody: tryParse(bodies.requestBodyRaw),
        responseBodyRaw: bodies.responseBodyRaw,
        responseBody: tryParse(bodies.responseBodyRaw),
        sseFrames: bodies.sseFrames ?? [],
      },
    };
  });
}

function tryParse(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
