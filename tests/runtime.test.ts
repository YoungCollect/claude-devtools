import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assembleStreamResponse, providerForPath } from '../src/core/adapters/index.js';
import { anthropicAdapter } from '../src/core/adapters/anthropic.js';
import { openaiAdapter } from '../src/core/adapters/openai.js';
import { isSensitiveHeader, redactHeaders } from '../src/core/redact.js';
import { SseParser } from '../src/core/sse.js';
import { Store } from '../src/core/store.js';
import { TraceBuilder } from '../src/core/trace-builder.js';
import type { TransportRecord } from '../src/core/types.js';
import { orderedClients, runCommand } from '../src/core/clients.js';
import { createApi } from '../src/server/api.js';
import { parseArgs } from '../src/server/cli.js';
import { loadConfig } from '../src/server/config.js';
import { Persistence } from '../src/server/persistence.js';
import { createProxy, serverPort } from '../src/server/proxy.js';
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

test('renaming a conversation survives a restart and later requests on the same trace', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agent-devtools-rename-')), 'traces.db');
  const store = new Store();
  const persistence = new Persistence({ file, maxBytes: 1_000_000 });
  const builder = new TraceBuilder(store);
  const runtime = new CaptureRuntime({ store, builder, persistence });

  const first = request('rename_first');
  runtime.hooks.onRequestStart(first);
  runtime.hooks.onRequestBody(first);
  first.status = 200;
  first.timing.endedAt = 2;
  runtime.hooks.onResponseStart(first);
  runtime.hooks.onComplete(first);

  const conversationId = first.conversationId ?? '';
  assert.ok(conversationId);
  assert.equal(runtime.renameConversation(conversationId, 'Payments bug hunt'), true);
  assert.equal(store.getConversation(conversationId)?.title, 'Payments bug hunt');
  assert.equal(runtime.renameConversation('conv_missing', 'nowhere'), false);

  // A later turn on the same trace re-saves the conversation; the human's name
  // is not a derived field, so it must not be recomputed away.
  const second = request('rename_second', 'hello');
  second.timing.startedAt = 3;
  runtime.hooks.onRequestStart(second);
  runtime.hooks.onRequestBody(second);
  second.status = 200;
  second.timing.endedAt = 4;
  runtime.hooks.onResponseStart(second);
  runtime.hooks.onComplete(second);
  assert.equal(store.getConversation(conversationId)?.title, 'Payments bug hunt');

  persistence.close();
  const reopened = new Persistence({ file, maxBytes: 1_000_000 });
  const restored = reopened
    .loadAll()
    .conversations.find(({ conversation }) => conversation.id === conversationId);
  assert.equal(restored?.conversation.title, 'Payments bug hunt');
  // Reconstruction state is untouched: a rename says nothing about history.
  assert.deepEqual(restored?.state.fps.length, 1);
  reopened.close();
});

test('the rename endpoint requires a usable title and an existing conversation', async () => {
  const renames: { id: string; title: string }[] = [];
  const app = createApi({
    store: new Store(),
    config: loadConfig([], {}),
    clearState: () => {},
    deleteConversation: () => true,
    renameConversation: (id, title) => {
      if (id !== 'conv_1') return false;
      renames.push({ id, title });
      return true;
    },
  });
  const patch = (body: string) =>
    app.request('/api/conversations/conv_1', {
      method: 'PATCH',
      headers: { 'x-agent-devtools': '1', 'content-type': 'application/json' },
      body,
    });

  assert.equal((await patch('{"title":"   "}')).status, 400);
  assert.equal((await patch('{"title":42}')).status, 400);
  assert.equal((await patch('not json')).status, 400);
  assert.equal((await patch(JSON.stringify({ title: 'x'.repeat(201) }))).status, 400);
  assert.deepEqual(renames, []);

  const ok = await patch('{"title":"  Payments bug hunt  "}');
  assert.equal(ok.status, 200);
  // Stored trimmed, so the sidebar never shows padding the user cannot see.
  assert.deepEqual(renames, [{ id: 'conv_1', title: 'Payments bug hunt' }]);

  const missing = await app.request('/api/conversations/conv_gone', {
    method: 'PATCH',
    headers: { 'x-agent-devtools': '1', 'content-type': 'application/json' },
    body: '{"title":"ghost"}',
  });
  assert.equal(missing.status, 404);
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
  let renamed = 0;
  const app = createApi({
    store: new Store(),
    config: loadConfig([], {}),
    clearState: () => {
      cleared += 1;
    },
    deleteConversation: () => true,
    renameConversation: () => {
      renamed += 1;
      return true;
    },
  });

  // A cross-origin page can send this much without a preflight.
  const bare = await app.request('/api/clear', { method: 'POST' });
  assert.equal(bare.status, 403);
  assert.equal(cleared, 0);

  const bareDelete = await app.request('/api/conversations/conv_1', { method: 'DELETE' });
  assert.equal(bareDelete.status, 403);

  // Rename mutates the capture too, so it carries the same guard.
  const bareRename = await app.request('/api/conversations/conv_1', {
    method: 'PATCH',
    body: JSON.stringify({ title: 'renamed by a random page' }),
  });
  assert.equal(bareRename.status, 403);
  assert.equal(renamed, 0);

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

/**
 * A turn rebuilt from a later request's history has no response to take a model
 * from, so it borrows the one that request asked for — flagged, because it is
 * that request's model and not something this turn's response ever stated.
 *
 * Timing has no such fallback: the wire carries no duration for a turn whose
 * response was never captured, and inventing one from the revealing request
 * would report the wrong exchange's latency.
 */
test('history-revealed assistant turns borrow the request model and stay untimed', () => {
  const store = new Store();
  const builder = new TraceBuilder(store);

  // The proxy attaches mid-conversation: the first request it ever sees already
  // replays an assistant turn whose response it never captured.
  const attach = request('midattach_turn1');
  attach.requestBody = {
    model: 'claude-opus-5',
    tools: [{ name: 'Bash' }],
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'an answer from before capture started' },
      { role: 'user', content: 'second question' },
    ],
  };
  builder.onRequestBody(attach);

  const conversationId = attach.conversationId ?? '';
  const revealed = store
    .getNodes(conversationId)
    .find((node) => node.kind === 'assistant' && node.text?.startsWith('an answer'));

  assert.ok(revealed, 'the replayed assistant turn is on the trace');
  assert.equal(revealed.model, 'claude-opus-5', 'it borrows the revealing request model');
  assert.equal(revealed.modelFromRequest, true, 'and is marked as second-hand');
  assert.equal(revealed.durationMs, undefined, 'no timing exists for an unobserved response');
  assert.equal(revealed.producedByRequestId, undefined);
  assert.equal(revealed.revealedByRequestId, attach.id);

  // The user turn beside it is not model output and borrows nothing.
  const userNode = store
    .getNodes(conversationId)
    .find((node) => node.kind === 'user' && node.text === 'second question');
  assert.equal(userNode?.model, undefined);
  assert.equal(userNode?.modelFromRequest, undefined);

  // A turn watched live keeps the response's own model, unflagged.
  attach.isStream = true;
  builder.onStreamFrames(attach, [
    frame('message_start', {
      type: 'message_start',
      message: { model: 'claude-opus-5-20260101', usage: { input_tokens: 3 } },
    }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: 'live answer' },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ]);

  const produced = store
    .getNodes(conversationId)
    .find((node) => node.producedByRequestId === attach.id);
  assert.equal(produced?.model, 'claude-opus-5-20260101', 'the response model wins over the request');
  assert.equal(produced?.modelFromRequest, undefined, 'an observed model is not flagged');
  assert.equal(typeof produced?.durationMs, 'number', 'a watched block is timed');
});

/**
 * A failed turn is still that turn: the UI draws it as an assistant row with a
 * model name, so the error node has to carry one. Unlike history-revealed
 * turns it needs no `modelFromRequest` flag — the failure belongs to this
 * exchange, so this exchange's model is the right answer.
 */
test('error nodes carry the model of the exchange that failed', () => {
  const store = new Store();
  const builder = new TraceBuilder(store);

  // Upstream refuses before a single frame arrives — the rate-limit case.
  const refused = request('rate_limited');
  builder.onRequestBody(refused);
  refused.error = "rate_limit_error: This request would exceed your account's rate limit.";
  refused.timing.endedAt = 5;
  builder.onComplete(refused);

  const conversationId = refused.conversationId ?? '';
  const failure = store.getNodes(conversationId).find((node) => node.kind === 'error');
  assert.ok(failure, 'the failure is on the trace');
  assert.equal(failure.model, 'test-model', 'it names the model this call asked for');
  assert.equal(failure.modelFromRequest, undefined, 'this exchange is not second-hand');
  assert.equal(failure.producedByRequestId, refused.id);

  // An error raised mid-stream, after `message_start` has named the model.
  const midStream = request('errored_mid_stream', 'second question', 10);
  builder.onRequestBody(midStream);
  midStream.isStream = true;
  builder.onStreamFrames(midStream, [
    frame('message_start', {
      type: 'message_start',
      message: { model: 'test-model-20260101' },
    }),
    frame('error', { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }),
  ]);

  const streamed = store
    .getNodes(midStream.conversationId ?? '')
    .filter((node) => node.kind === 'error')
    .at(-1);
  assert.equal(streamed?.model, 'test-model-20260101', 'the response model wins once it arrives');
});

/**
 * The header's indicator has to answer "is the agent talking through the proxy
 * right now", not "is the devtools server up". The two diverged in the obvious
 * way: with every agent closed, the process kept running and the dot kept
 * pulsing all night.
 */
test('the in-flight count follows exchanges through the proxy, not captured records', () => {
  const store = new Store();
  const runtime = new CaptureRuntime({ store, builder: new TraceBuilder(store) });
  assert.equal(store.snapshot().activeRequests, 0);

  const streamed = request('active_streamed');
  const aborted = request('active_aborted', 'second question');

  // Counted from the request line, before the body identifies the provider —
  // the earliest moment there is traffic to report.
  runtime.hooks.onRequestStart(streamed);
  assert.equal(store.snapshot().activeRequests, 1);
  runtime.hooks.onRequestStart(aborted);
  assert.equal(store.snapshot().activeRequests, 2);

  runtime.hooks.onRequestBody(streamed);
  streamed.status = 200;
  streamed.timing.endedAt = 2;
  runtime.hooks.onResponseStart(streamed);
  runtime.hooks.onComplete(streamed);
  assert.equal(store.snapshot().activeRequests, 1);

  // Esc in Claude Code: the client hangs up before a response ever starts.
  aborted.error = 'client aborted';
  aborted.timing.endedAt = 3;
  runtime.hooks.onComplete(aborted);
  assert.equal(store.snapshot().activeRequests, 0);

  // Repeated completions reach the runtime on the error paths (`res.close`
  // after an upstream failure); they must not drive the count negative.
  runtime.hooks.onComplete(aborted);
  assert.equal(store.snapshot().activeRequests, 0);

  // Both records outlive their exchanges — the aborted one is still worth
  // inspecting. The indicator must not outlive them the same way.
  assert.equal(store.snapshot().transport.length, 2);
});

test('an exchange that outlives Clear counts as traffic until its socket closes', () => {
  const store = new Store();
  const runtime = new CaptureRuntime({ store, builder: new TraceBuilder(store) });
  const record = request('active_across_clear');

  runtime.hooks.onRequestStart(record);
  runtime.hooks.onRequestBody(record);
  runtime.clear();

  // Clear wipes what was captured; it does not close the agent's connection.
  assert.deepEqual(store.snapshot().transport, []);
  assert.deepEqual(store.snapshot().conversations, []);
  assert.equal(store.snapshot().activeRequests, 1);

  record.status = 200;
  record.timing.endedAt = 2;
  runtime.hooks.onResponseStart(record);
  runtime.hooks.onComplete(record);

  // Settled even though the generation check drops the capture on the floor.
  assert.equal(store.snapshot().activeRequests, 0);
  assert.deepEqual(store.snapshot().transport, []);
});

test('deleting a conversation mid-request still releases its in-flight exchange', () => {
  const store = new Store();
  const runtime = new CaptureRuntime({ store, builder: new TraceBuilder(store) });
  const record = request('active_across_delete');

  runtime.hooks.onRequestStart(record);
  runtime.hooks.onRequestBody(record);
  assert.equal(runtime.deleteConversation(record.conversationId ?? ''), true);
  assert.equal(store.snapshot().activeRequests, 1);

  record.timing.endedAt = 2;
  runtime.hooks.onComplete(record);
  assert.equal(store.snapshot().activeRequests, 0);
});

test('a record restored from disk with no end time is not reported as traffic', () => {
  const store = new Store();
  // What restore does with a row whose process died mid-stream: the record has
  // a start and no end, and nothing about it is live.
  const record = request('restored_mid_stream');
  record.bodiesOffloaded = true;
  store.putTransport(record);

  assert.equal(store.snapshot().transport.length, 1);
  assert.equal(store.snapshot().activeRequests, 0);
});

/**
 * The OpenAI wire format differs from Anthropic's in the two places the
 * reconstruction actually depends on: the system prompt is the leading
 * messages rather than a field, and nothing on the stream says a block ended.
 * This walks one tool round through both halves and then replays it as the
 * next request's history, which is the only thing that proves the two paths
 * fingerprint identically.
 */
test('an OpenAI tool round is reconstructed and continued by the next request', () => {
  const store = new Store();
  const builder = new TraceBuilder(store);

  const first = openaiRequest('openai_r1', [
    { role: 'system', content: 'You are Codex.' },
    { role: 'user', content: 'list the files' },
  ]);
  builder.onRequestBody(first);
  const conversationId = first.conversationId ?? '';

  assert.ok(conversationId);
  assert.equal(first.provider, 'openai');
  assert.equal(first.kind, 'conversation');
  assert.equal(store.getConversation(conversationId)?.agent, 'codex');

  first.isStream = true;
  builder.onStreamFrames(first, [
    chunk({ model: 'gpt-5', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
    chunk({ choices: [{ index: 0, delta: { content: 'On it.' } }] }),
    chunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: '' } },
            ],
          },
        },
      ],
    }),
    chunk({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] } }],
    }),
  ]);
  builder.onStreamFrames(first, [
    chunk({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }],
    }),
  ]);
  // `finish_reason` in a batch of its own: the adapter can no longer name the
  // tool block from these frames alone, so closing it falls to the builder.
  builder.onStreamFrames(first, [
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    chunk({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } }),
  ]);
  first.timing.endedAt = 5;
  builder.onComplete(first);

  assert.deepEqual(
    store.getNodes(conversationId).map((node) => node.kind),
    ['system', 'user', 'assistant', 'tool_call'],
  );
  const call = store.getNodes(conversationId)[3];
  assert.equal(call?.toolName, 'shell');
  // Reassembled from four fragments across three network batches.
  assert.deepEqual(call?.toolInput, { cmd: 'ls' });
  assert.deepEqual(first.usage, { inputTokens: 12, outputTokens: 7 });

  // The same turn, replayed as history — `arguments` is a JSON string here and
  // was a parsed object on the stream, so this only matches because the adapter
  // parses it on the way in.
  const second = openaiRequest(
    'openai_r2',
    [
      { role: 'system', content: 'You are Codex.' },
      { role: 'user', content: 'list the files' },
      {
        role: 'assistant',
        content: 'On it.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'AGENTS.md\nsrc' },
    ],
    6,
  );
  builder.onRequestBody(second);

  assert.equal(second.conversationId, conversationId);
  assert.equal(store.listConversations().length, 1);
  assert.deepEqual(
    store.getNodes(conversationId).map((node) => node.kind),
    ['system', 'user', 'assistant', 'tool_call', 'tool_result'],
  );
  const result = store.getNodes(conversationId)[4];
  assert.equal(result?.toolUseId, 'call_1');
  assert.equal(result?.toolName, 'shell');
});

test('the OpenAI system prompt is the leading messages, and a later one stays history', () => {
  const record = openaiRequest('openai_system', [
    { role: 'system', content: 'Rules.' },
    { role: 'developer', content: 'More rules.' },
    { role: 'user', content: 'hi' },
    { role: 'system', content: 'Reminder mid-run.' },
    { role: 'user', content: 'still there?' },
  ]);
  const parsed = openaiAdapter.parseRequest(record);

  assert.equal(parsed.system, 'Rules.\n\nMore rules.');
  assert.deepEqual(
    parsed.history.map((item) => item.kind),
    ['user', 'system', 'user'],
  );

  // The prompt has no field of its own, so the Inspector's drill-down points
  // at the array it actually lives in.
  assert.equal(openaiAdapter.inspectRequest(record)?.bodyFields?.system, 'messages');
  assert.equal(openaiAdapter.inspectRequest(record)?.systemText, 'Rules.\n\nMore rules.');
  assert.deepEqual(openaiAdapter.inspectRequest(record)?.toolNames, ['shell']);
});

test('an OpenAI stream assembles into the same neutral response model', () => {
  const record = openaiRequest('openai_assemble', [{ role: 'user', content: 'hi' }]);
  record.isStream = true;
  record.sseFrames = [
    chunk({ model: 'gpt-5', choices: [{ index: 0, delta: { role: 'assistant', content: 'he' } }] }),
    chunk({ choices: [{ index: 0, delta: { content: 'llo' } }] }),
    chunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_9', type: 'function', function: { name: 'shell', arguments: '{}' } },
            ],
          },
        },
      ],
    }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  ];

  assert.deepEqual(assembleStreamResponse(record), {
    blocks: [
      { index: 0, kind: 'assistant', text: 'hello' },
      { index: 2, kind: 'tool_call', name: 'shell', text: '{}' },
    ],
    stopReason: 'tool_calls',
  });
});

function openaiRequest(id: string, messages: unknown[], startedAt = 1): TransportRecord {
  return {
    id,
    provider: 'unknown',
    kind: 'other',
    method: 'POST',
    path: '/v1/chat/completions',
    url: 'https://api.openai.com/v1/chat/completions',
    requestHeaders: { 'user-agent': 'codex_cli_rs/0.4.0', session_id: 'session-under-test' },
    requestBody: {
      model: 'gpt-5',
      tools: [{ type: 'function', function: { name: 'shell', parameters: {} } }],
      messages,
    },
    isStream: false,
    sseFrames: [],
    timing: { startedAt },
    requestBytes: 1,
    responseBytes: 0,
  };
}

/** Chat completions carry no `event:` field — only `data:` chunks. */
function chunk(data: unknown) {
  return { data, raw: '', t: 1 };
}

test('paths are routed to the provider that claims them', () => {
  assert.equal(providerForPath('/v1/messages'), 'anthropic');
  assert.equal(providerForPath('/v1/messages?beta=true'), 'anthropic');
  assert.equal(providerForPath('/v1/chat/completions'), 'openai');
  // A gateway that mounts the API under a prefix is still recognisable.
  assert.equal(providerForPath('/openai/deployments/gpt-5/chat/completions'), 'openai');
  // Nothing in these paths says which provider they belong to; the caller
  // decides where they go rather than the adapter guessing.
  assert.equal(providerForPath('/v1/models'), undefined);
  assert.equal(providerForPath('/oauth/token'), undefined);
});

test('one proxy port forwards each provider to its own upstream', async () => {
  const anthropic = await stubUpstream('anthropic-upstream');
  const openai = await stubUpstream('openai-upstream');
  const captured: string[] = [];

  const proxy = createProxy({
    resolveUpstream: (path) => (providerForPath(path) === 'openai' ? openai.url : anthropic.url),
    host: '127.0.0.1',
    port: 0,
    hooks: {
      onRequestStart: (record) => captured.push(record.path),
      onRequestBody: () => undefined,
      onResponseStart: () => undefined,
      onStreamFrames: () => undefined,
      onComplete: () => undefined,
    },
  });
  await once(proxy, 'listening');
  const base = `http://127.0.0.1:${serverPort(proxy)}`;

  try {
    assert.equal(await postTo(`${base}/v1/messages`), 'anthropic-upstream');
    assert.equal(await postTo(`${base}/v1/chat/completions`), 'openai-upstream');
    // Two providers, back to back, on the one listener — and a path neither
    // adapter claims still reaches the fallback rather than failing.
    assert.equal(await postTo(`${base}/v1/models`), 'anthropic-upstream');
    assert.deepEqual(captured, ['/v1/messages', '/v1/chat/completions', '/v1/models']);
  } finally {
    proxy.close();
    anthropic.close();
    openai.close();
  }
});

/**
 * Two runs that differ *only* by provider.
 *
 * Same system prompt, same opening message, so every fingerprint the matcher
 * compares is identical — the merge this prevents is not hypothetical, it is
 * what happens the moment a Claude Code session and a Codex session share a
 * directory and a proxy port.
 */
test('an OpenAI run and an Anthropic run are never merged into one trace', () => {
  const store = new Store();
  const builder = new TraceBuilder(store);

  const claude = request('shared_anthropic');
  claude.requestBody = {
    model: 'test-model',
    system: 'Shared instructions.',
    tools: [{ name: 'Bash' }],
    messages: [{ role: 'user', content: 'hello' }],
  };
  builder.onRequestBody(claude);

  const codex = openaiRequest('shared_openai', [
    { role: 'system', content: 'Shared instructions.' },
    { role: 'user', content: 'hello' },
  ]);
  builder.onRequestBody(codex);

  assert.equal(claude.provider, 'anthropic');
  assert.equal(codex.provider, 'openai');
  assert.notEqual(claude.conversationId, codex.conversationId);
  assert.deepEqual(
    store.listConversations().map((conversation) => conversation.provider),
    ['anthropic', 'openai'],
  );
});

/** An upstream that answers every request with its own name. */
async function stubUpstream(name: string) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(name);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${serverPort(server)}`,
    close: () => server.close(),
  };
}

async function postTo(url: string): Promise<string> {
  const response = await fetch(url, { method: 'POST', body: '{}' });
  return response.text();
}

test('the command line configures the run and outranks the environment', () => {
  const config = loadConfig(
    [
      '--client',
      'codex',
      '--proxy-url',
      'http://127.0.0.1:4999',
      '--ui-port=4998',
      '--upstream',
      'https://openrouter.ai/api/',
      '--no-persist',
      '--max-bytes',
      '2048',
    ],
    {
      AGENT_DEVTOOLS_PROXY_PORT: '4141',
      AGENT_DEVTOOLS_OPENAI_UPSTREAM: 'https://ignored.example',
    },
  );

  assert.equal(config.proxyPort, 4999);
  assert.equal(config.uiPort, 4998);
  // `--client` decides where paths that name no provider go, and which run
  // command the banner and the UI put first.
  assert.equal(config.defaultProvider, 'openai');
  // `--upstream` follows `--client`; the trailing slash is normalised away so
  // the proxy does not join paths onto it twice.
  assert.equal(config.upstreams.openai, 'https://openrouter.ai/api');
  // The provider that was not selected keeps its default.
  assert.equal(config.upstreams.anthropic, 'https://api.anthropic.com');
  assert.equal(config.persist, false);
  assert.equal(config.maxBytes, 2048);

  // Order on the line does not change what `--upstream` means.
  assert.deepEqual(parseArgs(['--upstream', 'https://example.test', '--client', 'codex']).upstreams, {
    openai: 'https://example.test',
  });
  assert.equal(loadConfig([], {}).defaultProvider, 'anthropic');
});

test('the command line rejects what it cannot honour', () => {
  assert.throws(() => parseArgs(['--client', 'gemini']), /--client must be one of/);
  // The loopback rule is enforced wherever a host can first be named, not only
  // on the environment variable.
  assert.throws(() => parseArgs(['--proxy-url', 'http://10.0.0.5:4141']), /must be on 127\.0\.0\.1/);
  assert.throws(() => parseArgs(['--proxy-url', 'http://127.0.0.1']), /must include a port/);
  assert.equal(parseArgs(['--proxy-url', 'http://localhost:4141']).proxyPort, 4141);
  assert.throws(() => parseArgs(['--ui-port', 'abc']), /positive integer/);
  assert.throws(() => parseArgs(['--upstream']), /needs a value/);
  assert.throws(() => parseArgs(['--openai-upstream', 'ftp://nope']), /must be an http\(s\) URL/);
  // A mistyped flag that was ignored would be a capture quietly doing something
  // other than what was asked for.
  assert.throws(() => parseArgs(['--no-persistt']), /unknown option --no-persistt/);
  // `pnpm start -- --client codex` hands the separator through; npm strips it.
  assert.equal(parseArgs(['--', '--client', 'codex']).client, 'openai');
});

test('the run command shown always matches the client the server was started for', () => {
  const forCodex = orderedClients('openai');
  assert.deepEqual(
    forCodex.map((client) => runCommand(client, 'http://127.0.0.1:4141')),
    [
      'OPENAI_BASE_URL=http://127.0.0.1:4141/v1 codex',
      'ANTHROPIC_BASE_URL=http://127.0.0.1:4141 claude',
    ],
  );
  // Every client is listed either way: one port routes them all, so running one
  // never rules out another.
  assert.equal(orderedClients('anthropic')[0]?.binary, 'claude');
  assert.equal(orderedClients(undefined).length, forCodex.length);
});

test('an OpenAI attachment is identified without hashing its payload', () => {
  const fingerprintOf = (content: unknown) =>
    openaiAdapter.parseRequest(
      openaiRequest('openai_attachment', [{ role: 'user', content }]),
    ).history[0]?.fp;

  const image = (data: string) => [
    { type: 'text', text: 'look at this' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
  ];

  // Two messages whose only difference is the image itself. Both render to the
  // same text, so without the attachment signature the prefix match would call
  // them the same block.
  assert.notEqual(fingerprintOf(image('a'.repeat(4096))), fingerprintOf(image('b'.repeat(4096))));
  assert.equal(fingerprintOf(image('a'.repeat(4096))), fingerprintOf(image('a'.repeat(4096))));

  // A plain message keeps the fingerprint it had before attachments were
  // considered at all, so conversations restored from disk still match.
  assert.equal(fingerprintOf('hello'), fingerprintOf([{ type: 'text', text: 'hello' }]));
});

test('a captured request names the URL it was actually sent to', async () => {
  // An upstream mounted under a base path — a gateway, or `--upstream
  // https://openrouter.ai/api`.
  const upstream = await stubUpstream('mounted-upstream');
  const records: TransportRecord[] = [];
  const proxy = createProxy({
    resolveUpstream: () => `${upstream.url}/api`,
    host: '127.0.0.1',
    port: 0,
    hooks: {
      onRequestStart: (record) => records.push(record),
      onRequestBody: () => undefined,
      onResponseStart: () => undefined,
      onStreamFrames: () => undefined,
      onComplete: () => undefined,
    },
  });
  await once(proxy, 'listening');

  try {
    await postTo(`http://127.0.0.1:${serverPort(proxy)}/v1/messages`);
    // Not `${upstream.url}/v1/messages`: that is where resolving the path
    // against the upstream as a base would claim it went, and no request was
    // ever made to it.
    assert.equal(records[0]?.url, `${upstream.url}/api/v1/messages`);
    assert.equal(records[0]?.path, '/v1/messages');
  } finally {
    proxy.close();
    upstream.close();
  }
});
