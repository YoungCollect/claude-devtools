import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { ConversationState } from '../src/core/trace-builder.js';
import type { Conversation, TraceNode, TransportRecord } from '../src/core/types.js';
import { Persistence } from '../src/server/persistence.js';

test('repairs legacy node sequences and preserves append order across restarts', () => {
  const file = temporaryDatabase();
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      node TEXT NOT NULL
    )
  `);
  const insert = legacy.prepare(
    'INSERT INTO nodes (id, conversation_id, seq, node) VALUES (?, ?, ?, ?)',
  );
  insert.run('node_1', 'conv_1', 2, JSON.stringify(node('node_1')));
  insert.run('node_2', 'conv_1', 2, JSON.stringify(node('node_2')));
  legacy.close();

  let persistence = new Persistence({ file, maxBytes: 1_000_000 });
  assert.deepEqual(
    persistence.loadAll().nodes.map(({ id }) => id),
    ['node_1', 'node_2'],
  );
  persistence.saveNode(node('node_3'));
  persistence.close();

  persistence = new Persistence({ file, maxBytes: 1_000_000 });
  assert.deepEqual(
    persistence.loadAll().nodes.map(({ id }) => id),
    ['node_1', 'node_2', 'node_3'],
  );
  persistence.close();
});

test('retention protects active conversations and trims bodies before metadata', () => {
  const persistence = new Persistence({ file: temporaryDatabase(), maxBytes: 120 });
  persistence.saveConversation(conversation('conv_old', 1), state('conv_old', 1));
  persistence.saveConversation(conversation('conv_active', 2), state('conv_active', 2));
  persistence.saveTransport(transport('request_old', 'conv_old', 1));
  persistence.saveTransport(transport('request_active', 'conv_active', 2));

  const evicted = persistence.sweep(new Set(['conv_active']));
  const loaded = persistence.loadAll();

  assert.deepEqual(evicted, ['conv_old']);
  assert.deepEqual(
    loaded.conversations.map(({ conversation: item }) => item.id),
    ['conv_active'],
  );
  assert.deepEqual(
    loaded.transport.map(({ id }) => id),
    ['request_active'],
  );
  assert.equal(persistence.loadBodies('request_active'), undefined);
  assert.ok(persistence.totalBytes() <= 120);
  persistence.close();
});

test('deleting one conversation removes only its durable rows', () => {
  const persistence = new Persistence({ file: temporaryDatabase(), maxBytes: 1_000_000 });
  persistence.saveConversation(conversation('conv_1', 1), state('conv_1', 1));
  persistence.saveConversation(conversation('conv_2', 2), state('conv_2', 2));
  persistence.saveNode(node('node_1', 'conv_1'));
  persistence.saveNode(node('node_2', 'conv_2'));
  persistence.saveTransport(transport('request_1', 'conv_1', 1));
  persistence.saveTransport(transport('request_2', 'conv_2', 2));

  persistence.deleteConversation('conv_1');
  const loaded = persistence.loadAll();

  assert.deepEqual(
    loaded.conversations.map(({ conversation: item }) => item.id),
    ['conv_2'],
  );
  assert.deepEqual(loaded.nodes.map(({ id }) => id), ['node_2']);
  assert.deepEqual(loaded.transport.map(({ id }) => id), ['request_2']);
  assert.equal(persistence.loadBodies('request_1'), undefined);
  assert.ok(persistence.loadBodies('request_2'));
  persistence.close();
});

test('renaming reports whether a durable row was actually rewritten', () => {
  const persistence = new Persistence({ file: temporaryDatabase(), maxBytes: 1_000_000 });
  persistence.saveConversation(conversation('conv_1', 1), state('conv_1', 1));

  assert.equal(persistence.renameConversation('conv_1', 'Payments bug hunt'), true);
  // Retention may have evicted the row before the rename reached disk.
  assert.equal(persistence.renameConversation('conv_gone', 'ghost'), false);

  const loaded = persistence.loadAll();
  assert.equal(loaded.conversations[0]?.conversation.title, 'Payments bug hunt');
  // Only the display column moved; reconstruction still resumes from disk.
  assert.deepEqual(loaded.conversations[0]?.state, state('conv_1', 1));
  persistence.close();
});

function temporaryDatabase(): string {
  return join(mkdtempSync(join(tmpdir(), 'claude-devtools-test-')), 'traces.db');
}

function node(id: string, conversationId = 'conv_1'): TraceNode {
  return { id, conversationId, kind: 'user', ts: 1, text: id };
}

function conversation(id: string, updatedAt: number): Conversation {
  return {
    id,
    title: id,
    agent: 'test',
    provider: 'anthropic',
    startedAt: updatedAt,
    updatedAt,
    requestCount: 1,
    nodeCount: 0,
    usage: {},
  };
}

function state(id: string, updatedAt: number): ConversationState {
  return {
    id,
    fps: [],
    producedFps: new Set(),
    systemFp: 'system',
    turnCount: 1,
    updatedAt,
  };
}

function transport(id: string, conversationId: string, startedAt: number): TransportRecord {
  return {
    id,
    provider: 'anthropic',
    kind: 'conversation',
    method: 'POST',
    path: '/v1/messages',
    url: 'https://api.anthropic.com/v1/messages',
    requestHeaders: {},
    requestBodyRaw: 'x'.repeat(200),
    isStream: false,
    sseFrames: [],
    timing: { startedAt, endedAt: startedAt + 1 },
    requestBytes: 200,
    responseBytes: 0,
    conversationId,
  };
}
