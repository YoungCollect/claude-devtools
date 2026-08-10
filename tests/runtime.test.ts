import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assembleStreamResponse } from '../src/core/adapters/index.js';
import { anthropicAdapter } from '../src/core/adapters/anthropic.js';
import { isSensitiveHeader, redactHeaders } from '../src/core/redact.js';
import { SseParser } from '../src/core/sse.js';
import { Store } from '../src/core/store.js';
import { TraceBuilder } from '../src/core/trace-builder.js';
import type { TransportRecord } from '../src/core/types.js';
import { createApi } from '../src/server/api.js';
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

test('deleting a conversation prevents its in-flight request from repopulating the store', () => {
  const store = new Store();
  const runtime = new CaptureRuntime({ store, builder: new TraceBuilder(store) });
  const record = request('request_before_delete');

  runtime.hooks.onRequestStart(record);
  runtime.hooks.onRequestBody(record);
  const conversationId = record.conversationId ?? '';
  assert.ok(conversationId);
  assert.equal(runtime.deleteConversation(conversationId), true);
  assert.equal(runtime.deleteConversation(conversationId), false);

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

test('trace separates system, tagged context, and real user text by payload structure', () => {
  const store = new Store();
  const builder = new TraceBuilder(store);
  const first = request('structured_roles');
  first.requestBody = {
    model: 'test-model',
    system: 'You are the runtime system prompt.',
    tools: [{ name: 'Bash' }],
    messages: [
      { role: 'system', content: 'System message injection.' },
      {
        role: 'user',
        content:
          '<system-reminder priority="high">injected</system-reminder>\n' +
          'hello from the human\n' +
          '<command-name>/review</command-name>',
      },
    ],
  };

  builder.onRequestBody(first);
  const conversationId = first.conversationId ?? '';
  assert.deepEqual(
    store.getNodes(conversationId).map(({ kind, contextTag, systemSource, text }) => ({
      kind,
      contextTag,
      systemSource,
      text,
    })),
    [
      {
        kind: 'system',
        contextTag: undefined,
        systemSource: 'prompt',
        text: 'You are the runtime system prompt.',
      },
      {
        kind: 'system',
        contextTag: undefined,
        systemSource: 'message',
        text: 'System message injection.',
      },
      {
        kind: 'context',
        contextTag: 'system-reminder',
        systemSource: undefined,
        text: '<system-reminder priority="high">injected</system-reminder>',
      },
      {
        kind: 'user',
        contextTag: undefined,
        systemSource: undefined,
        text: 'hello from the human',
      },
      {
        kind: 'context',
        contextTag: 'command-name',
        systemSource: undefined,
        text: '<command-name>/review</command-name>',
      },
    ],
  );
  assert.equal(store.getConversation(conversationId)?.title, 'hello from the human');

  const repeated = { ...first, id: 'structured_roles_repeated', conversationId: undefined };
  builder.onRequestBody(repeated);
  assert.equal(repeated.conversationId, conversationId);
  assert.equal(store.getNodes(conversationId).length, 5);
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

/**
 * A fresh agent session must start its own trace, even though its first request
 * repeats the previous session's injected context verbatim.
 *
 * Reproduces an observed merge: two runs in the same directory open with the
 * same CLAUDE.md and environment blocks, so the new session's first request
 * shared a 3-block prefix with a conversation that had grown to 12 blocks. The
 * system prompt differed — the signal that they were different sessions — but it
 * was only a tiebreaker, and with a single candidate it never got a say.
 */
test('a new session with matching boilerplate but a different system prompt starts its own trace', () => {
  const store = new Store();
  const builder = new TraceBuilder(store);

  // Shared, environment-derived opening blocks — identical across sessions.
  const boilerplate = [
    { role: 'user', content: '<system-reminder>project context</system-reminder>' },
    { role: 'user', content: '<env>cwd=/repo</env>' },
  ];

  const session = (id: string, systemPrompt: string, tail: { role: string; content: string }[]) => {
    const record = request(id);
    record.requestBody = {
      model: 'test-model',
      tools: [{ name: 'Bash' }],
      system: systemPrompt,
      messages: [...boilerplate, ...tail],
    };
    builder.onRequestBody(record);
    return record;
  };

  // Session one grows over several turns.
  const first = session('sessionA_turn1', 'SYSTEM PROMPT A /scratch/aaaa', [
    { role: 'user', content: 'first question' },
  ]);
  const grown = session('sessionA_turn2', 'SYSTEM PROMPT A /scratch/aaaa', [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ]);
  assert.equal(grown.conversationId, first.conversationId, 'same session must continue one trace');

  // A brand new session: same boilerplate prefix, shorter history, new prompt.
  const fresh = session('sessionB_turn1', 'SYSTEM PROMPT B /scratch/bbbb', [
    { role: 'user', content: 'hello i am andy' },
  ]);
  assert.notEqual(
    fresh.conversationId,
    first.conversationId,
    'a different system prompt means a different session',
  );
  assert.equal(store.snapshot().conversations.length, 2);

  // The old trace must not have been rewound to the boilerplate prefix.
  const originalNodes = store.getNodes(first.conversationId!);
  assert.ok(
    originalNodes.some((node) => node.text?.includes('second question')),
    'the established trace keeps its own history',
  );
  assert.ok(
    !originalNodes.some((node) => node.text?.includes('hello i am andy')),
    'the new session must not be appended to the old trace',
  );
});

/** Genuine compaction — same system prompt, shorter history — still continues. */
test('a compacted history with the same system prompt continues its trace', () => {
  const store = new Store();
  const builder = new TraceBuilder(store);
  const SYSTEM = 'SYSTEM PROMPT A /scratch/aaaa';

  const send = (id: string, messages: { role: string; content: string }[]) => {
    const record = request(id);
    record.requestBody = { model: 'test-model', tools: [{ name: 'Bash' }], system: SYSTEM, messages };
    builder.onRequestBody(record);
    return record;
  };

  const long = send('compaction_turn1', [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'q3' },
  ]);
  const compacted = send('compaction_turn2', [
    { role: 'user', content: 'q1' },
    { role: 'user', content: 'q4 after compaction' },
  ]);

  assert.equal(compacted.conversationId, long.conversationId);
  assert.equal(store.snapshot().conversations.length, 1);
});

/**
 * The case a system-prompt fingerprint cannot catch on its own: two runs whose
 * system prompts are byte-identical. Claude Code sends its own run id, so the
 * builder does not have to infer session identity from the prompt at all.
 */
test('two runs with an identical system prompt are separated by the run id', () => {
  const store = new Store();
  const builder = new TraceBuilder(store);
  const SYSTEM = 'IDENTICAL SYSTEM PROMPT';
  const boilerplate = [{ role: 'user', content: '<env>cwd=/repo</env>' }];

  const send = (id: string, runId: string | undefined, tail: { role: string; content: string }[]) => {
    const record = request(id);
    if (runId) record.requestHeaders['x-claude-code-session-id'] = runId;
    record.requestBody = {
      model: 'test-model',
      tools: [{ name: 'Bash' }],
      system: SYSTEM,
      messages: [...boilerplate, ...tail],
    };
    builder.onRequestBody(record);
    return record;
  };

  const runA1 = send('runA_1', 'session-aaaa', [{ role: 'user', content: 'question one' }]);
  const runA2 = send('runA_2', 'session-aaaa', [
    { role: 'user', content: 'question one' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: 'question two' },
  ]);
  assert.equal(runA2.conversationId, runA1.conversationId, 'same run id continues one trace');

  const runB1 = send('runB_1', 'session-bbbb', [{ role: 'user', content: 'hello i am andy' }]);
  assert.notEqual(runB1.conversationId, runA1.conversationId, 'a different run id is a new trace');
  assert.equal(store.snapshot().conversations.length, 2);
});

/** Agents that send no run id must keep working off the system prompt alone. */
test('conversations without a run id still match on the system prompt', () => {
  const store = new Store();
  const builder = new TraceBuilder(store);

  const send = (id: string, system: string, messages: { role: string; content: string }[]) => {
    const record = request(id);
    delete record.requestHeaders['x-claude-code-session-id'];
    record.requestBody = { model: 'test-model', tools: [{ name: 'Bash' }], system, messages };
    builder.onRequestBody(record);
    return record;
  };

  const first = send('noid_1', 'PROMPT A', [{ role: 'user', content: 'q1' }]);
  const second = send('noid_2', 'PROMPT A', [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ]);
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(store.snapshot().conversations.length, 1);
});

test('SSE frames survive a multi-byte character split across chunks', () => {
  const frame = Buffer.from(
    'event: content_block_delta\ndata: {"delta":{"text":"你好世界"}}\n\n',
    'utf8',
  );
  const insideFirstChar = frame.indexOf(Buffer.from('你', 'utf8')) + 1;

  const parser = new SseParser();
  const frames = [
    ...parser.pushBytes(frame.subarray(0, insideFirstChar), 1),
    ...parser.pushBytes(frame.subarray(insideFirstChar), 2),
    ...parser.end(3),
  ];

  assert.equal(frames.length, 1);
  const data = frames[0]?.data as { delta: { text: string } };
  assert.equal(data.delta.text, '你好世界');
  // The Raw view has to show the real bytes too, not a repaired copy of them.
  assert.ok(frames[0]?.raw.includes('你好世界'));
});

test('a byte-at-a-time stream still parses identically', () => {
  const bytes = Buffer.from('data: {"text":"héllo — 世界 🌏"}\n\n', 'utf8');
  const parser = new SseParser();
  const frames = [];
  for (const byte of bytes) frames.push(...parser.pushBytes(Uint8Array.of(byte), 0));
  frames.push(...parser.end(0));

  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0]?.data, { text: 'héllo — 世界 🌏' });
});

test('credential headers are masked by name and by shape', () => {
  // Named, and the ones no list anticipated.
  for (const name of ['authorization', 'x-api-key', 'x-goog-api-key', 'x-acme-auth-token', 'session-secret']) {
    assert.equal(isSensitiveHeader(name), true, `${name} must be masked`);
  }
  for (const name of ['content-type', 'user-agent', 'anthropic-version', 'accept']) {
    assert.equal(isSensitiveHeader(name), false, `${name} must not be masked`);
  }

  const masked = redactHeaders({ 'x-acme-auth-token': 'sk-live-abcdefghijklmnop' }, false);
  assert.ok(!masked['x-acme-auth-token']?.includes('efghijklm'));
  assert.equal(redactHeaders({ 'x-acme-auth-token': 'v' }, true)['x-acme-auth-token'], 'v');
});

test('a tool-less request is only utility when it looks like a side call', () => {
  const kind = (body: unknown, path = '/v1/messages') =>
    anthropicAdapter.parseRequest({
      id: 'r', provider: 'anthropic', kind: 'other', method: 'POST', path,
      url: `https://api.anthropic.com${path}`, requestHeaders: {}, requestBody: body,
      isStream: false, sseFrames: [], timing: { startedAt: 0 },
    }).kind;

  // Claude Code's side calls: one message, no tools, barely any budget.
  assert.equal(kind({ max_tokens: 512, messages: [{ role: 'user', content: 'name this' }] }), 'utility');
  assert.equal(kind({ messages: [] }, '/v1/messages/count_tokens'), 'utility');

  // A one-shot SDK call asks for room to answer, and must reach the trace.
  assert.equal(kind({ max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] }), 'conversation');
  // So must a second turn, which the old message-count rule also swallowed.
  assert.equal(
    kind({ max_tokens: 512, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }),
    'conversation',
  );
  // Tools are still decisive on their own.
  assert.equal(kind({ max_tokens: 8, tools: [{ name: 'Bash' }], messages: [{ role: 'user', content: 'x' }] }), 'conversation');
});

test('an attachment is fingerprinted without hashing its payload', () => {
  const image = (data: string) => ({
    role: 'user',
    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
  });
  const parse = (message: unknown) =>
    anthropicAdapter.parseRequest({
      id: 'r', provider: 'anthropic', kind: 'other', method: 'POST', path: '/v1/messages',
      url: 'https://api.anthropic.com/v1/messages', requestHeaders: {},
      requestBody: { messages: [message] }, isStream: false, sseFrames: [], timing: { startedAt: 0 },
    }).history;

  const big = 'A'.repeat(4_000_000);
  const started = Date.now();
  const first = parse(image(big))[0]?.fp;
  const elapsed = Date.now() - started;

  // Same bytes, same id; different bytes, different id.
  assert.equal(parse(image(big))[0]?.fp, first);
  assert.notEqual(parse(image(`${big}B`))[0]?.fp, first);
  assert.notEqual(parse(image('A'.repeat(4_000_000 - 1) + 'B'))[0]?.fp, first);

  // Hashing the payload itself took ~4M character iterations per turn, on the
  // synchronous path that forwards the request.
  assert.ok(elapsed < 250, `fingerprinting a 4 MB attachment took ${elapsed}ms`);
});

test('--no-persist bounds resident bodies instead of keeping or dropping them all', () => {
  const store = new Store();
  const builder = new TraceBuilder(store);
  // A budget two bodies wide, so the third arrival has to release the first.
  const runtime = new CaptureRuntime({ store, builder, maxResidentBodyBytes: 240 });

  const complete = (id: string, startedAt: number) => {
    const record = request(id, `message ${id}`, startedAt);
    record.requestBodyRaw = 'x'.repeat(100);
    record.responseBodyRaw = 'y'.repeat(20);
    runtime.hooks.onRequestStart(record);
    runtime.hooks.onRequestBody(record);
    record.status = 200;
    record.timing.endedAt = startedAt + 1;
    runtime.hooks.onResponseStart(record);
    runtime.hooks.onComplete(record);
    return record;
  };

  const first = complete('body_1', 1);
  const second = complete('body_2', 3);
  // Still inside the budget: both remain openable in the Inspector.
  assert.equal(first.requestBodyRaw?.length, 100);
  assert.equal(second.requestBodyRaw?.length, 100);

  const third = complete('body_3', 5);
  // Over budget — the oldest gives up its body, the newest keeps it.
  assert.equal(first.requestBodyRaw, undefined);
  assert.equal(first.responseBodyRaw, undefined);
  assert.equal(second.requestBodyRaw?.length, 100);
  assert.equal(third.requestBodyRaw?.length, 100);

  // Nothing claims to be recoverable, because no database was written.
  assert.equal(first.bodiesOffloaded, undefined);

  // The drain ran every time, so the dirty sets are not growing unbounded.
  assert.deepEqual(builder.drain(), { nodes: [], conversations: [] });

  // Metadata is untouched: the trace stays readable, only old bodies are gone.
  assert.equal(store.snapshot().transport.length, 3);
});

test('clear releases every resident body', () => {
  const store = new Store();
  const runtime = new CaptureRuntime({
    store,
    builder: new TraceBuilder(store),
    maxResidentBodyBytes: 1_000_000,
  });
  const record = request('kept_in_memory');
  record.requestBodyRaw = 'sensitive prompt text';
  runtime.hooks.onRequestStart(record);
  runtime.hooks.onRequestBody(record);
  record.status = 200;
  record.timing.endedAt = 2;
  runtime.hooks.onResponseStart(record);
  runtime.hooks.onComplete(record);
  assert.ok(record.requestBodyRaw);

  runtime.clear();
  // Clear is expected to remove captured material, not just unlink it.
  assert.equal(record.requestBodyRaw, undefined);
});

test('state-changing endpoints reject a request that did not come from the UI', async () => {
  let cleared = 0;
  const app = createApi({
    store: new Store(),
    config: loadConfig([], {}),
    clearState: () => {
      cleared += 1;
    },
    deleteConversation: () => true,
  });

  // A cross-origin page can send this much without a preflight.
  const bare = await app.request('/api/clear', { method: 'POST' });
  assert.equal(bare.status, 403);
  assert.equal(cleared, 0);

  const bareDelete = await app.request('/api/conversations/conv_1', { method: 'DELETE' });
  assert.equal(bareDelete.status, 403);

  // The header is not a secret; carrying it is what forces a preflight, and a
  // preflight is what this API never answers.
  const fromUi = await app.request('/api/clear', {
    method: 'POST',
    headers: { 'x-agent-devtools': '1' },
  });
  assert.equal(fromUi.status, 200);
  assert.equal(cleared, 1);

  // Reads stay open — without CORS headers a cross-origin caller cannot read them.
  assert.equal((await app.request('/api/state')).status, 200);
});
