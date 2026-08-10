import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assembleStreamResponse } from '../src/core/adapters/index.js';
import { Store } from '../src/core/store.js';
import { TraceBuilder } from '../src/core/trace-builder.js';
import type { TransportRecord } from '../src/core/types.js';
import { loadConfig } from '../src/server/config.js';
import { Persistence } from '../src/server/persistence.js';
import { CaptureRuntime } from '../src/server/runtime.js';

test('clear prevents an in-flight request from repopulating the store', () => {
  const store = new Store();
  const runtime = new CaptureRuntime({ store, builder: new TraceBuilder(store) });
  const record = request('request_before_clear');

  runtime.hooks.onRequestStart(record);
  runtime.hooks.onRequestBody(record);
  assert.equal(store.listConversations().length, 1);

  runtime.clear();
  record.status = 200;
  record.timing.endedAt = 2;
  runtime.hooks.onResponseStart(record);
  runtime.hooks.onComplete(record);

  assert.deepEqual(store.snapshot().conversations, []);
  assert.deepEqual(store.snapshot().transport, []);
});

test('retention does not evict another conversation that is still in flight', () => {
  const store = new Store();
  const persistence = new Persistence({
    file: join(mkdtempSync(join(tmpdir(), 'agent-devtools-runtime-')), 'traces.db'),
    maxBytes: 120,
  });
  const runtime = new CaptureRuntime({
    store,
    builder: new TraceBuilder(store),
    persistence,
  });
  const older = request('older_in_flight', 'older conversation', 1);
  const completing = request('completing', 'newer conversation', 2);

  runtime.hooks.onRequestStart(older);
  runtime.hooks.onRequestBody(older);
  runtime.hooks.onRequestStart(completing);
  runtime.hooks.onRequestBody(completing);

  completing.requestBodyRaw = 'x'.repeat(200);
  completing.timing.endedAt = 3;
  runtime.hooks.onComplete(completing);

  assert.equal(store.listConversations().length, 2);
  assert.ok(store.getConversation(older.conversationId ?? ''));
  persistence.close();
});

test('configuration rejects non-loopback listeners and malformed limits', () => {
  assert.throws(
    () => loadConfig([], { AGENT_DEVTOOLS_HOST: '0.0.0.0' }),
    /must be 127\.0\.0\.1/,
  );
  assert.throws(
    () => loadConfig([], { AGENT_DEVTOOLS_PROXY_PORT: '4141oops' }),
    /positive integer/,
  );
  assert.equal(loadConfig([], {}).host, '127.0.0.1');
});

test('provider adapter assembles a neutral streamed response for the UI', () => {
  const record = request('stream');
  record.isStream = true;
  record.sseFrames = [
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: 'hel' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'lo' },
    }),
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
    }),
  ];

  assert.deepEqual(assembleStreamResponse(record), {
    blocks: [{ index: 0, kind: 'assistant', text: 'hello' }],
    stopReason: 'end_turn',
  });
});

function request(id: string, message = 'hello', startedAt = 1): TransportRecord {
  return {
    id,
    provider: 'unknown',
    kind: 'other',
    method: 'POST',
    path: '/v1/messages',
    url: 'https://api.anthropic.com/v1/messages',
    requestHeaders: { 'user-agent': 'claude-cli/test' },
    requestBody: {
      model: 'test-model',
      tools: [{ name: 'Bash' }],
      messages: [{ role: 'user', content: message }],
    },
    isStream: false,
    sseFrames: [],
    timing: { startedAt },
    requestBytes: 1,
    responseBytes: 0,
  };
}

function frame(event: string, data: unknown) {
  return { event, data, raw: '', t: 1 };
}
