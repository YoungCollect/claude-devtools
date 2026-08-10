import assert from 'node:assert/strict';
import test from 'node:test';

import { transportForConversation } from '../src/web/transport.js';
import { jsonContainer } from '../src/web/json.js';
import { focusBodyField } from '../src/web/inspect-focus.js';
import { anthropicAdapter } from '../src/core/adapters/anthropic.js';
import type { TraceNode, TraceNodeKind } from '../src/core/types.js';

test('network transport is isolated to the selected conversation', () => {
  const rows = [
    { id: 'alpha-1', conversationId: 'alpha' },
    { id: 'beta-1', conversationId: 'beta' },
    { id: 'utility' },
  ];

  assert.deepEqual(transportForConversation(rows, 'alpha'), [rows[0]]);
  assert.deepEqual(transportForConversation(rows, 'beta'), [rows[1]]);
  assert.deepEqual(transportForConversation(rows, undefined), []);
});

test('JSON body renderer accepts parsed or raw containers and rejects non-JSON text', () => {
  const parsed = { message: 'hello' };
  assert.equal(jsonContainer(parsed), parsed);
  assert.deepEqual(jsonContainer(undefined, '{"items":[1,2]}'), { items: [1, 2] });
  assert.equal(jsonContainer(undefined, 'not json'), undefined);
  assert.equal(jsonContainer('primitive', '"primitive"'), undefined);
});

function traceNode(kind: TraceNodeKind, extra: Partial<TraceNode> = {}): TraceNode {
  return { id: `${kind}-1`, conversationId: 'c1', kind, ts: 0, ...extra };
}

const BODY_FIELDS = { system: 'system', history: 'messages', tools: 'tools' };

test('trace nodes drill down into the body field they came out of', () => {
  const field = (node: TraceNode) => focusBodyField(node, BODY_FIELDS);

  assert.equal(field(traceNode('system', { systemSource: 'prompt' })), 'system');
  // A system-role history message is not the request-level prompt.
  assert.equal(field(traceNode('system', { systemSource: 'message' })), 'messages');

  for (const kind of ['context', 'user', 'assistant', 'thinking', 'tool_call', 'tool_result'] as const) {
    assert.equal(field(traceNode(kind)), 'messages', `${kind} should point at the history`);
  }

  // Reconstructed rows have no field of their own to point at.
  assert.equal(field(traceNode('compaction')), undefined);
  assert.equal(field(traceNode('error')), undefined);
});

test('drill-down stays quiet when the adapter named no field for it', () => {
  assert.equal(focusBodyField(traceNode('user'), undefined), undefined);
  assert.equal(focusBodyField(undefined, BODY_FIELDS), undefined);
  // A request that sent no system prompt must not offer to expand one.
  assert.equal(focusBodyField(traceNode('system'), { history: 'messages' }), undefined);
});

test('the Anthropic adapter names only the body fields the request actually sent', () => {
  const inspect = (requestBody: unknown) =>
    anthropicAdapter.inspectRequest({
      id: 'r1',
      provider: 'anthropic',
      kind: 'conversation',
      method: 'POST',
      path: '/v1/messages',
      url: 'https://api.anthropic.com/v1/messages',
      requestHeaders: {},
      requestBody,
      isStream: false,
      sseFrames: [],
      timing: { startedAt: 0 },
    })?.bodyFields;

  assert.deepEqual(inspect({ system: 'be brief', messages: [], tools: [] }), {
    system: 'system',
    history: 'messages',
    tools: 'tools',
  });
  assert.deepEqual(inspect({ messages: [] }), { history: 'messages' });
  assert.deepEqual(inspect({}), {});
});
