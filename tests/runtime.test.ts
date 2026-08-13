import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assembleStreamResponse, findAdapter } from '../src/core/adapters/index.js';
import { anthropicAdapter } from '../src/core/adapters/anthropic.js';
import { fingerprint } from '../src/core/fingerprint.js';
import { isSensitiveHeader, redactHeaders } from '../src/core/redact.js';
import { SseParser } from '../src/core/sse.js';
import { Store } from '../src/core/store.js';
import { TraceBuilder } from '../src/core/trace-builder.js';
import type { TransportRecord } from '../src/core/types.js';
import { CLAUDE_CODE, manualRunCommand, runCommand } from '../src/core/clients.js';
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
  const file = join(mkdtempSync(join(tmpdir(), 'claude-devtools-rename-')), 'traces.db');
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
      headers: { 'x-claude-devtools': '1', 'content-type': 'application/json' },
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
    headers: { 'x-claude-devtools': '1', 'content-type': 'application/json' },
    body: '{"title":"ghost"}',
  });
  assert.equal(missing.status, 404);
});

test('retention does not evict another conversation that is still in flight', () => {
  const store = new Store();
  const persistence = new Persistence({
    file: join(mkdtempSync(join(tmpdir(), 'claude-devtools-runtime-')), 'traces.db'),
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
    () => loadConfig([], { CLAUDE_DEVTOOLS_HOST: '0.0.0.0' }),
    /must be 127\.0\.0\.1/,
  );
  assert.throws(
    () => loadConfig([], { CLAUDE_DEVTOOLS_PROXY_PORT: '4141oops' }),
    /positive integer/,
  );
  assert.throws(
    () => loadConfig([], { CLAUDE_DEVTOOLS_UPSTREAM: 'file:///tmp/upstream' }),
    /must be an http\(s\) URL/,
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
        content: [
          {
            type: 'text',
            text: '<system-reminder priority="high">injected</system-reminder>',
          },
          { type: 'text', text: 'hello from the human' },
          { type: 'text', text: '<command-name>/review</command-name>' },
        ],
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
  assert.deepEqual(
    store.getNodes(conversationId).map(({ sourcePath }) => sourcePath),
    [
      undefined,
      ['messages', 0, 'content'],
      ['messages', 1, 'content', 0],
      ['messages', 1, 'content', 1],
      ['messages', 1, 'content', 2],
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

  const masked = redactHeaders({ 'x-acme-auth-token': 'sk-live-abcdefghijklmnop' });
  assert.ok(!masked['x-acme-auth-token']?.includes('efghijklm'));
  assert.equal(redactHeaders({ 'x-acme-auth-token': 'v' })['x-acme-auth-token'], '••••••');
});

test('the transport API never reveals credentials, including for the retired reveal query', async () => {
  const store = new Store();
  const record = request('masked_transport');
  record.requestHeaders.authorization = 'Bearer credential-that-must-stay-masked';
  store.putTransport(record);
  const app = createApi({
    store,
    config: loadConfig([], {}),
    clearState: () => {},
    deleteConversation: () => false,
    renameConversation: () => false,
  });

  const response = await app.request('/api/transport/masked_transport?reveal=1');
  const body = (await response.json()) as {
    record: { requestHeaders: Record<string, string> };
  };
  assert.equal(response.status, 200);
  assert.ok(!body.record.requestHeaders.authorization?.includes('must-stay-masked'));
});

test('a tool-less request is only utility when it looks like a side call', () => {
  const kind = (
    body: unknown,
    requestHeaders: Record<string, string> = {},
    path = '/v1/messages',
  ) =>
    anthropicAdapter.parseRequest({
      id: 'r', provider: 'anthropic', kind: 'other', method: 'POST', path,
      url: `https://api.anthropic.com${path}`, requestHeaders, requestBody: body,
      isStream: false, sseFrames: [], timing: { startedAt: 0 }, requestBytes: 0, responseBytes: 0,
    }).kind;

  const run = { 'x-claude-code-session-id': 'sess-1' };

  // Claude Code's side calls: a run id, no tools, one message.
  assert.equal(kind({ max_tokens: 512, messages: [{ role: 'user', content: 'name this' }] }, run), 'utility');
  assert.equal(kind({ messages: [] }, {}, '/v1/messages/count_tokens'), 'utility');
  // The budget is not the signal, and reading it as one was the bug: Claude
  // Code's title call asks for as much room as a real turn.
  assert.equal(kind({ max_tokens: 64_000, messages: [{ role: 'user', content: 'name this' }] }, run), 'utility');

  // The side call that summarises a session replays the whole transcript, so
  // message count says nothing about which of the two it is. Reading a long one
  // as a turn is what opened a second conversation mirroring the first.
  assert.equal(
    kind(
      {
        max_tokens: 512,
        messages: Array.from({ length: 12 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `m${i}`,
        })),
      },
      run,
    ),
    'utility',
  );
  assert.equal(
    kind({ max_tokens: 512, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }, run),
    'utility',
  );

  // A runtime that sends no run id — the SDK, Mastra — declares no tools either,
  // so the run id is the only thing keeping its turns in the trace. However many
  // messages it carries, and however small its budget.
  assert.equal(kind({ max_tokens: 512, messages: [{ role: 'user', content: 'hi' }] }), 'conversation');
  assert.equal(kind({ max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] }), 'conversation');
  assert.equal(
    kind({ max_tokens: 512, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }),
    'conversation',
  );

  // Tools are still decisive on their own.
  assert.equal(kind({ max_tokens: 8, tools: [{ name: 'Bash' }], messages: [{ role: 'user', content: 'x' }] }, run), 'conversation');
});

test('a side call replaying the whole transcript does not mirror the conversation', () => {
  // The reported bug: `/goal` and `/loop` each left two near-identical traces in
  // the sidebar. The second was a summarisation call — no tools, its own short
  // system prompt, and the entire transcript attached. Read as a turn, it matched
  // no existing conversation (different system prompt, so different identity) and
  // rebuilt every message into a conversation of its own.
  const store = new Store(100);
  const builder = new TraceBuilder(store);
  const run = { 'x-claude-code-session-id': 'sess-1' };

  const request = (
    id: string,
    body: unknown,
    startedAt: number,
  ): TransportRecord => ({
    id, provider: 'anthropic', kind: 'other', method: 'POST', path: '/v1/messages',
    url: 'https://api.anthropic.com/v1/messages', requestHeaders: run, requestBody: body,
    isStream: false, sseFrames: [], timing: { startedAt }, requestBytes: 0, responseBytes: 0,
  });

  const agentSystem = 'You are Claude Code, an interactive CLI tool.';
  const history = [
    { role: 'user', content: 'add a retry to the upload client' },
    { role: 'assistant', content: 'looking at the client now' },
    { role: 'user', content: 'three attempts is enough' },
  ];

  const turn = request('turn', {
    max_tokens: 64_000,
    system: agentSystem,
    tools: [{ name: 'Bash' }, { name: 'Edit' }],
    messages: history,
  }, 100);
  builder.onRequestBody(turn);
  assert.equal(store.snapshot().conversations.length, 1);
  const conversationId = store.snapshot().conversations[0]?.id ?? '';
  const nodesAfterTurn = store.getNodes(conversationId).length;

  // Same session, same history, no tools, a different and much shorter system
  // prompt. Every one of those is what the real capture showed.
  const summary = request('summary', {
    max_tokens: 512,
    system: 'You summarise conversations.',
    messages: history,
  }, 140);
  builder.onRequestBody(summary);

  assert.equal(summary.kind, 'utility');
  assert.equal(
    store.snapshot().conversations.length,
    1,
    'the side call must not open a second, mirrored conversation',
  );
  assert.equal(summary.conversationId, conversationId, 'it belongs to the session it came from');

  // It contributes only what it brought of its own — its system prompt — and
  // not one echo of the transcript it was handed.
  const added = store.getNodes(conversationId).slice(nodesAfterTurn);
  assert.deepEqual(
    added.map(({ kind, text }) => ({ kind, text })),
    [{ kind: 'system', text: 'You summarise conversations.' }],
  );
  assert.ok(added.every((node) => node.sideCall), 'and it is marked as background activity');
});

test('a subagent still gets its own trace despite sharing the session id', () => {
  // The guard on the fix above. A `Task` subagent reuses its parent's run id and
  // differs only by system prompt, so it is told apart the same way the mirrored
  // side call was — except a subagent declares tools, and so stays a
  // conversation. If classification ever collapses that distinction, this fails.
  const store = new Store(100);
  const builder = new TraceBuilder(store);
  const run = { 'x-claude-code-session-id': 'sess-1' };

  const request = (id: string, body: unknown, startedAt: number): TransportRecord => ({
    id, provider: 'anthropic', kind: 'other', method: 'POST', path: '/v1/messages',
    url: 'https://api.anthropic.com/v1/messages', requestHeaders: run, requestBody: body,
    isStream: false, sseFrames: [], timing: { startedAt }, requestBytes: 0, responseBytes: 0,
  });

  const parent = request('parent', {
    max_tokens: 64_000,
    system: 'You are Claude Code, an interactive CLI tool.',
    tools: [{ name: 'Task' }, { name: 'Bash' }],
    messages: [{ role: 'user', content: 'review the diff' }],
  }, 100);
  builder.onRequestBody(parent);

  const subagent = request('subagent', {
    max_tokens: 64_000,
    system: 'You are a code review subagent.',
    tools: [{ name: 'Read' }, { name: 'Grep' }],
    messages: [{ role: 'user', content: 'review these files' }],
  }, 200);
  builder.onRequestBody(subagent);

  assert.equal(subagent.kind, 'conversation');
  assert.equal(store.snapshot().conversations.length, 2, 'parent and subagent stay distinct');
  assert.notEqual(subagent.conversationId, parent.conversationId);
});

test('a side call joins its session rather than opening a trace of its own', () => {
  const store = new Store(100);
  const builder = new TraceBuilder(store);
  const run = { 'x-claude-code-session-id': 'sess-1' };

  const request = (
    id: string,
    body: unknown,
    requestHeaders: Record<string, string>,
    startedAt: number,
  ): TransportRecord => ({
    id, provider: 'anthropic', kind: 'other', method: 'POST', path: '/v1/messages',
    url: 'https://api.anthropic.com/v1/messages', requestHeaders, requestBody: body,
    isStream: false, sseFrames: [], timing: { startedAt }, requestBytes: 0, responseBytes: 0,
  });

  // Claude Code fires the title call first — observed 8ms ahead of the turn it
  // names — so it arrives before there is any conversation to join.
  const title = request('side', {
    max_tokens: 64_000,
    system: 'You name conversations.',
    messages: [{ role: 'user', content: 'Write the title in the predominant language' }],
  }, run, 100);
  builder.onRequestBody(title);
  assert.equal(title.kind, 'utility');
  assert.equal(title.conversationId, undefined, 'nothing to attach to yet');
  assert.equal(store.snapshot().conversations.length, 0, 'a side call never opens a trace');

  const turn = request('turn', {
    max_tokens: 64_000,
    system: 'You are Claude Code.',
    tools: [{ name: 'Bash' }],
    messages: [{ role: 'user', content: 'hello claude' }],
  }, run, 108);
  builder.onRequestBody(turn);

  const conversations = store.snapshot().conversations;
  assert.equal(conversations.length, 1, 'one session, one trace');
  const conversationId = conversations[0]?.id ?? '';
  // Titled from the turn, not from the side call's prompt.
  assert.equal(conversations[0]?.title, 'hello claude');
  // The waiting side call was drained into the session it named.
  assert.equal(title.conversationId, conversationId);
  assert.ok((title.turnIndex ?? -1) < (turn.turnIndex ?? -1), 'it happened first, so it is numbered first');

  const nodes = store.getNodes(conversationId);
  assert.deepEqual(
    nodes.map((node) => node.revealedByRequestId ?? node.producedByRequestId),
    ['side', 'side', 'turn', 'turn'],
    'trace nodes follow request order and keep one request contiguous',
  );
  const side = nodes.filter((node) => node.sideCall);
  assert.equal(side.length, 2);
  assert.deepEqual(
    side.map((node) => [node.kind, node.systemSource, node.text]),
    [
      ['system', 'prompt', 'You name conversations.'],
      ['user', undefined, 'Write the title in the predominant language'],
    ],
  );
  // And it stayed out of the transcript: the turn's own message is the only
  // user node the diff knows about, so the next request still extends cleanly.
  const ordinaryUser = nodes.filter((node) => node.kind === 'user' && !node.sideCall);
  assert.deepEqual(ordinaryUser.map((node) => node.text), ['hello claude']);

  // A second turn extends the same trace rather than being read as a rewind.
  const next = request('turn2', {
    max_tokens: 64_000,
    system: 'You are Claude Code.',
    tools: [{ name: 'Bash' }],
    messages: [
      { role: 'user', content: 'hello claude' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'and again' },
    ],
  }, run, 200);
  builder.onRequestBody(next);
  assert.equal(store.snapshot().conversations.length, 1);
  assert.equal(next.conversationId, conversationId);
});

test('a full-history tool-less Claude Code side call does not duplicate its conversation', () => {
  const store = new Store(100);
  const builder = new TraceBuilder(store);
  const headers = {
    'user-agent': 'claude-cli/test',
    'x-claude-code-session-id': 'sess-full-history',
  };
  const history = [
    { role: 'user', content: 'inspect the repository' },
    { role: 'assistant', content: 'I will inspect it.' },
    { role: 'user', content: 'continue' },
  ];
  const send = (id: string, body: unknown, startedAt: number): TransportRecord => {
    const record = request(id, '', startedAt);
    record.requestHeaders = headers;
    record.requestBody = body;
    builder.onRequestBody(record);
    return record;
  };

  const turn = send(
    'full_history_turn',
    {
      model: 'test-model',
      system: 'You are Claude Code with the full runtime prompt.',
      tools: [{ name: 'Bash' }, { name: 'Task' }],
      messages: history,
    },
    100,
  );
  const side = send(
    'full_history_side',
    {
      model: 'test-model',
      system: 'Summarize the transcript for a slash command.',
      tools: [],
      messages: history,
    },
    101,
  );

  assert.equal(side.kind, 'utility');
  assert.equal(side.conversationId, turn.conversationId);
  assert.equal(store.snapshot().conversations.length, 1, 'the replayed history must not open a mirror');

  const nodes = store.getNodes(turn.conversationId ?? '');
  assert.equal(nodes.filter((node) => !node.sideCall && node.kind === 'user').length, 2);
  assert.ok(nodes.some((node) => node.sideCall && node.revealedByRequestId === side.id));
});

test('a Task subagent sharing the parent run id keeps its own conversation', () => {
  const store = new Store(100);
  const builder = new TraceBuilder(store);
  const headers = {
    'user-agent': 'claude-cli/test',
    'x-claude-code-session-id': 'sess-parent-and-task',
  };
  const send = (id: string, system: string, message: string): TransportRecord => {
    const record = request(id, '', 100);
    record.requestHeaders = headers;
    record.requestBody = {
      model: 'test-model',
      system,
      tools: [{ name: 'Bash' }, { name: 'Task' }],
      messages: [{ role: 'user', content: message }],
    };
    builder.onRequestBody(record);
    return record;
  };

  const parent = send('task_parent', 'You are the parent Claude Code agent.', 'delegate this');
  const subagent = send('task_child', 'You are the dedicated Task subagent.', 'do the delegated work');

  assert.notEqual(subagent.conversationId, parent.conversationId);
  assert.equal(store.snapshot().conversations.length, 2);
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
    headers: { 'x-claude-devtools': '1' },
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

test('a replayed tool call is matched by tool_use_id when the client normalizes its input', () => {
  const store = new Store();
  const builder = new TraceBuilder(store);
  const first = request('tool_turn');

  builder.onRequestBody(first);
  first.isStream = true;
  builder.onStreamFrames(first, [
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"command":"wrapper command","description":"check"}',
      },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ]);

  const next = request('tool_result_turn', 'unused', 10);
  next.requestBody = {
    model: 'test-model',
    tools: [{ name: 'Bash' }],
    messages: [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            // Claude Code may replay a semantically equivalent, normalized
            // input rather than the exact JSON emitted on the SSE stream.
            input: { command: 'command', description: 'check' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
        ],
      },
    ],
  };
  builder.onRequestBody(next);

  assert.equal(next.conversationId, first.conversationId);
  const nodes = store.getNodes(first.conversationId ?? '');
  const calls = nodes.filter(
    (node) => node.kind === 'tool_call' && node.toolUseId === 'toolu_1',
  );
  const results = nodes.filter(
    (node) => node.kind === 'tool_result' && node.toolUseId === 'toolu_1',
  );
  assert.equal(calls.length, 1, 'history replay must not duplicate the streamed call');
  assert.equal(calls[0]?.producedByRequestId, first.id);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.revealedByRequestId, next.id);
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

test('the Claude-only command line configures one upstream and launches Claude Code', () => {
  const config = loadConfig(
    [
      'run',
      '--proxy-url',
      'http://127.0.0.1:4999',
      '--ui-port=4998',
      '--upstream',
      'https://gateway.example/anthropic/',
      '--no-persist',
      '--max-bytes',
      '2048',
      '--',
      '--model',
      'sonnet',
    ],
    { CLAUDE_DEVTOOLS_PROXY_PORT: '4141' },
  );

  assert.equal(config.proxyPort, 4999);
  assert.equal(config.uiPort, 4998);
  assert.equal(config.upstream, 'https://gateway.example/anthropic');
  assert.equal(config.persist, false);
  assert.equal(config.maxBytes, 2048);

  const parsed = parseArgs(['run', '--proxy-port', '4200', '--', '--model', 'sonnet']);
  assert.equal(parsed.runClient, CLAUDE_CODE);
  assert.deepEqual(parsed.runArgs, ['--model', 'sonnet']);
  assert.deepEqual(CLAUDE_CODE.pointAt('http://127.0.0.1:4141'), {
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4141' },
    args: [],
  });
  assert.equal(
    manualRunCommand('http://127.0.0.1:4141'),
    'ANTHROPIC_BASE_URL=http://127.0.0.1:4141 claude',
  );
  assert.equal(runCommand(), 'claude-devtools run');
  assert.equal(runCommand(4998), 'claude-devtools run --ui-port 4998');
});

test('the Claude-only command line rejects legacy provider selection', () => {
  assert.throws(() => parseArgs(['run', 'codex']), /unknown option codex/);
  assert.throws(() => parseArgs(['--client', 'codex']), /unknown option --client/);
  assert.throws(() => parseArgs(['--openai-upstream', 'https://api.openai.com']), /unknown option/);
  assert.throws(() => parseArgs(['--proxy-url', 'http://10.0.0.5:4141']), /must be on 127\.0\.0\.1/);
  assert.throws(() => parseArgs(['--upstream', 'ftp://example.com']), /must be an http\(s\) URL/);
});

test('the single proxy upstream receives every Claude Code request path', async () => {
  const upstream = await stubUpstream('anthropic-upstream');
  const proxy = createProxy({
    upstream: upstream.url,
    host: '127.0.0.1',
    port: 0,
    hooks: {
      onRequestStart: () => undefined,
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
    assert.equal(await postTo(`${base}/v1/messages/count_tokens`), 'anthropic-upstream');
    assert.equal(await postTo(`${base}/v1/models`), 'anthropic-upstream');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a captured request names the URL it was actually sent to', async () => {
  // An upstream mounted under a base path — a gateway, or `--upstream
  // https://openrouter.ai/api`.
  const upstream = await stubUpstream('mounted-upstream');
  const records: TransportRecord[] = [];
  const proxy = createProxy({
    upstream: `${upstream.url}/api`,
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
