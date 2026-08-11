import assert from 'node:assert/strict';
import test from 'node:test';

import { transportForConversation } from '../src/web/transport.js';
import { feedStatus } from '../src/web/activity.js';
import { jsonContainer } from '../src/web/json.js';
import { focusBodyField } from '../src/web/inspect-focus.js';
import { groupTrace, turnNodes } from '../src/web/trace-groups.js';
import { readRoute, routeHref } from '../src/web/route.js';
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

test('a turn folds its assistant text, tool calls and their results into one item', () => {
  const nodes: TraceNode[] = [
    traceNode('user', { id: 'n1' }),
    traceNode('assistant', { id: 'n2', producedByRequestId: 'r1', text: 'checking' }),
    traceNode('tool_call', { id: 'n3', producedByRequestId: 'r1', toolUseId: 't1', toolName: 'Bash' }),
    traceNode('tool_call', { id: 'n4', producedByRequestId: 'r1', toolUseId: 't2', toolName: 'Read' }),
    // Results arrive one request later, which is why they sit after the calls.
    traceNode('tool_result', { id: 'n5', revealedByRequestId: 'r2', toolUseId: 't1' }),
    traceNode('tool_result', { id: 'n6', revealedByRequestId: 'r2', toolUseId: 't2' }),
    traceNode('assistant', { id: 'n7', producedByRequestId: 'r2', text: 'done' }),
  ];

  const items = groupTrace(nodes);
  assert.deepEqual(
    items.map((item) => (item.type === 'turn' ? `turn:${item.key}` : `node:${item.node.id}`)),
    ['node:n1', 'turn:turn:n2', 'turn:turn:n7'],
  );

  const first = items[1];
  assert.equal(first?.type, 'turn');
  if (first?.type !== 'turn') return;
  assert.deepEqual(first.messages.map((n) => n.id), ['n2']);
  assert.deepEqual(
    first.tools.map(({ call, result }) => [call?.id, result?.id]),
    [
      ['n3', 'n5'],
      ['n4', 'n6'],
    ],
  );
  // Everything the turn renders stays reachable for selection and drill-down.
  assert.deepEqual(turnNodes(first).map((n) => n.id), ['n2', 'n3', 'n5', 'n4', 'n6']);
});

test('a mid-conversation attach still groups history-revealed turns', () => {
  // Nothing here was seen on a stream: the proxy attached late and read the
  // whole transcript out of one request's history, so no node has a
  // producedByRequestId to group on.
  const revealed = (kind: TraceNodeKind, extra: Partial<TraceNode>) =>
    traceNode(kind, { revealedByRequestId: 'rN', ...extra });

  const items = groupTrace([
    revealed('assistant', { id: 'a1', text: 'first' }),
    revealed('tool_call', { id: 'c1', toolUseId: 't1', toolName: 'Bash' }),
    revealed('tool_result', { id: 'r1', toolUseId: 't1' }),
    revealed('assistant', { id: 'a2', text: 'second' }),
    revealed('tool_call', { id: 'c2', toolUseId: 't2', toolName: 'Read' }),
  ]);

  // Two turns, not five rows and not one turn swallowing the whole transcript.
  assert.equal(items.length, 2);
  const [first, second] = items;
  assert.equal(first?.type === 'turn' ? first.messages[0]?.id : '', 'a1');
  assert.deepEqual(
    first?.type === 'turn' ? first.tools.map(({ call, result }) => [call?.id, result?.id]) : [],
    [['c1', 'r1']],
  );
  assert.equal(second?.type === 'turn' ? second.messages[0]?.id : '', 'a2');
});

test('a node between two responses closes the turn', () => {
  const items = groupTrace([
    traceNode('assistant', { id: 'a1', producedByRequestId: 'r1', text: 'before' }),
    traceNode('user', { id: 'u1' }),
    traceNode('assistant', { id: 'a2', producedByRequestId: 'r1', text: 'after' }),
  ]);
  // Same request id on both sides, but the user message is a real boundary.
  assert.deepEqual(items.map((i) => i.type), ['turn', 'node', 'turn']);
});

test('no tool node ever escapes grouping into a standalone row', () => {
  const nodes: TraceNode[] = [
    // A call with no result yet, a result whose call was never captured, and a
    // response that went straight to a tool without saying anything first.
    traceNode('tool_result', { id: 'orphan', toolUseId: 'gone' }),
    traceNode('tool_call', { id: 'silent', producedByRequestId: 'r9', toolUseId: 't9', toolName: 'Grep' }),
    traceNode('thinking', { id: 'think' }),
    traceNode('compaction', { id: 'banner' }),
  ];

  const items = groupTrace(nodes);
  const loose = items.filter(
    (item) => item.type === 'node' && (item.node.kind === 'tool_call' || item.node.kind === 'tool_result'),
  );
  assert.deepEqual(loose, [], 'tool nodes must always be folded into a turn');

  // The orphaned result still renders, in a turn of its own.
  const orphanTurn = items.find((item) => item.type === 'turn' && item.tools[0]?.result?.id === 'orphan');
  assert.ok(orphanTurn, 'an unmatched tool result must not be dropped');

  // A tool-only turn carries no assistant text but is still a turn.
  const silentTurn = items.find((item) => item.type === 'turn' && item.tools[0]?.call?.id === 'silent');
  assert.equal(silentTurn?.type === 'turn' ? silentTurn.messages.length : -1, 0);

  // Non-tool nodes keep their own rows.
  assert.deepEqual(
    items.filter((i) => i.type === 'node').map((i) => (i.type === 'node' ? i.node.id : '')),
    ['think', 'banner'],
  );
});

test('an assistant block with no text yet is not a row', () => {
  // The API opens a block before any delta lands. Dropping it here rather than
  // in the view keeps `groupTrace` the single answer to "what does the trace
  // show" — the Chat Trace tab badge counts exactly this result.
  const items = groupTrace([
    traceNode('user', { id: 'u1', text: 'hi' }),
    traceNode('assistant', { id: 'empty', producedByRequestId: 'r1' }),
    traceNode('assistant', { id: 'blank', producedByRequestId: 'r1', text: '   \n ' }),
  ]);
  assert.deepEqual(items.map((i) => (i.type === 'node' ? i.node.id : i.key)), ['u1']);

  // ...but a tool call from that same response still opens its turn, so an
  // agent that goes straight to a tool is never invisible.
  const withTool = groupTrace([
    traceNode('assistant', { id: 'empty', producedByRequestId: 'r1' }),
    traceNode('tool_call', { id: 'c1', producedByRequestId: 'r1', toolUseId: 't1', toolName: 'Bash' }),
  ]);
  assert.equal(withTool.length, 1);
  assert.equal(withTool[0]?.type === 'turn' ? withTool[0].messages.length : -1, 0);
  assert.equal(withTool[0]?.type === 'turn' ? withTool[0].tools[0]?.call?.id : '', 'c1');
});

test('the header indicator separates the change feed from traffic through the proxy', () => {
  // A running devtools server with no agent attached is `idle`, not `live`:
  // the connection being up says nothing about anyone using the proxy.
  assert.equal(feedStatus(true, false), 'idle');
  assert.equal(feedStatus(true, true), 'live');

  // A closed feed outranks whatever the last snapshot said about traffic —
  // that snapshot is exactly what has stopped being updated.
  assert.equal(feedStatus(false, false), 'offline');
  assert.equal(feedStatus(false, true), 'offline');
});

test('the selected conversation and view round-trip through the URL', () => {
  assert.deepEqual(readRoute({ pathname: '/', search: '' }), { view: 'trace' });
  assert.deepEqual(readRoute({ pathname: '/c/conv_7', search: '' }), {
    conversationId: 'conv_7',
    view: 'trace',
  });
  assert.deepEqual(readRoute({ pathname: '/c/conv_7', search: '?view=network' }), {
    conversationId: 'conv_7',
    view: 'network',
  });

  // The default view stays out of the address; anything unknown falls back to it.
  assert.equal(routeHref({ conversationId: 'conv_7', view: 'trace' }), '/c/conv_7');
  assert.equal(routeHref({ conversationId: 'conv_7', view: 'network' }), '/c/conv_7?view=network');
  assert.equal(routeHref({ view: 'trace' }), '/');
  assert.equal(readRoute({ pathname: '/c/conv_7', search: '?view=nonsense' }).view, 'trace');

  // Ids are escaped on the way out and read back whole, so a conversation id
  // carrying a slash cannot forge a different path.
  const awkward = 'conv/7 #1';
  const href = routeHref({ conversationId: awkward, view: 'network' });
  const [pathname, search] = href.split('?');
  assert.deepEqual(readRoute({ pathname: pathname ?? '', search: search ? `?${search}` : '' }), {
    conversationId: awkward,
    view: 'network',
  });

  // A trailing slash, an empty id and a path this app does not own all mean
  // "nothing selected" rather than a conversation named for the leftovers.
  assert.equal(readRoute({ pathname: '/c/', search: '' }).conversationId, undefined);
  assert.equal(readRoute({ pathname: '/c/conv_7/', search: '' }).conversationId, 'conv_7');
  assert.equal(readRoute({ pathname: '/settings', search: '' }).conversationId, undefined);
});
