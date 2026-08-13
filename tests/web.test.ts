import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { transportForConversation } from '../src/web/transport.js';
import { feedStatus } from '../src/web/activity.js';
import { jsonContainer, jsonNodeExpansion } from '../src/web/json.js';
import { focusBodyField } from '../src/web/inspect-focus.js';
import {
  exchangeHeaderFields,
  formatBackgroundActivitySummary,
  groupByRequest,
  groupTrace,
  groupTraceSections,
  inspectorTabForPhase,
  labelExchangePhase,
  splitExchangePhases,
  summarizeBackgroundActivity,
  turnNodes,
} from '../src/web/trace-groups.js';
import { readRoute, routeHref } from '../src/web/route.js';
import { gitDiffShortcut } from '../src/web/shortcuts.js';
import { greekLines } from '../src/web/greeking.js';
import { clearGitDiff, setGitDiffOpen, toggleGitDiffSource, useGitDiff } from '../src/web/git-diff.js';
import { DiffTray } from '../src/web/components/DiffTray.js';
import {
  completeTraceFilterInput,
  filterTraceSections,
  formatTraceFilterInput,
  parseTraceFilterNumbers,
} from '../src/web/trace-filter.js';
import { anthropicAdapter } from '../src/core/adapters/anthropic.js';
import { splitTaggedUserContent } from '../src/core/tagged-content.js';
import { ToolResultInputRow } from '../src/web/components/ToolResultInputRow.js';
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

test('a tag marks context only when it wraps the entire user text block', () => {
  const text =
    '<session>\nhow do you feel today?\n</session>\n\n' +
    'Write the title in the predominant language of the session.';

  assert.deepEqual(splitTaggedUserContent(text), [{ kind: 'user', text }]);
  assert.deepEqual(splitTaggedUserContent('<system-reminder>injected</system-reminder>'), [
    {
      kind: 'context',
      contextTag: 'system-reminder',
      text: '<system-reminder>injected</system-reminder>',
    },
  ]);
});

test('a focused JSON field opens its immediate container children only', () => {
  const systemBlock = { type: 'text', text: 'prompt' };
  const message = { role: 'user', content: 'hello' };
  const data = { system: [systemBlock], messages: [message] };
  const shouldExpand = jsonNodeExpansion(data, ['system']);

  assert.equal(shouldExpand(0, data), true);
  assert.equal(shouldExpand(1, data.system, 'system'), true);
  assert.equal(shouldExpand(1, data.messages, 'messages'), false);
  assert.equal(shouldExpand(2, systemBlock), true);
  assert.equal(shouldExpand(2, message), false);
  assert.equal(shouldExpand(3, systemBlock.text, 'text'), false);
});

test('an exact JSON source path opens only the matching message and content block', () => {
  const systemMessage = { role: 'system', content: 'injected system message' };
  const reminderBlock = { type: 'text', text: '<system-reminder>injected</system-reminder>' };
  const userMessage = { role: 'user', content: [reminderBlock] };
  const data = { messages: [systemMessage, userMessage] };
  const shouldExpand = jsonNodeExpansion(
    data,
    ['messages'],
    ['messages', 1, 'content', 0],
  );

  assert.equal(shouldExpand(0, data), true);
  assert.equal(shouldExpand(1, data.messages, 'messages'), true);
  assert.equal(shouldExpand(2, systemMessage), false);
  assert.equal(shouldExpand(2, userMessage), true);
  assert.equal(shouldExpand(3, userMessage.content, 'content'), true);
  assert.equal(shouldExpand(4, reminderBlock), true);

  const shouldExpandSystem = jsonNodeExpansion(
    data,
    ['messages'],
    ['messages', 0, 'content'],
  );
  assert.equal(shouldExpandSystem(2, systemMessage), true);
  assert.equal(shouldExpandSystem(2, userMessage), false);
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

test('a history-replayed tool call cannot steal the original call result', () => {
  const items = groupTrace([
    traceNode('tool_call', {
      id: 'streamed-call',
      producedByRequestId: 'r1',
      toolUseId: 't1',
      toolName: 'Bash',
      toolInput: { command: 'wrapper command' },
    }),
    traceNode('tool_call', {
      id: 'history-copy',
      revealedByRequestId: 'r2',
      toolUseId: 't1',
      toolName: 'Bash',
      toolInput: { command: 'command' },
    }),
    traceNode('tool_result', {
      id: 'result',
      revealedByRequestId: 'r2',
      toolUseId: 't1',
    }),
  ]);

  const turns = items.filter((item) => item.type === 'turn');
  assert.equal(turns.length, 1);
  const activity = turns[0]?.type === 'turn' ? turns[0].tools[0] : undefined;
  assert.equal(activity?.call?.id, 'streamed-call');
  assert.equal(activity?.result?.id, 'result');
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
  // A running devtools server with no traffic is `ready`, not `active`:
  // the connection being up says nothing about anyone using the proxy.
  assert.equal(feedStatus(true, false), 'ready');
  assert.equal(feedStatus(true, true), 'active');

  // A closed feed outranks whatever the last snapshot said about traffic —
  // that snapshot is exactly what has stopped being updated.
  assert.equal(feedStatus(false, false), 'offline');
  assert.equal(feedStatus(false, true), 'offline');
});

test('G then D opens Git Diff within the shortcut window', () => {
  const waiting = gitDiffShortcut(undefined, 'g', 1_000);
  assert.deepEqual(waiting, { waitingUntil: 2_000, openDiff: false });
  assert.deepEqual(gitDiffShortcut(waiting.waitingUntil, 'd', 1_500), {
    waitingUntil: undefined,
    openDiff: true,
  });
});

test('G then C closes Git Diff within the shortcut window', () => {
  const waiting = gitDiffShortcut(undefined, 'g', 1_000);
  assert.deepEqual(gitDiffShortcut(waiting.waitingUntil, 'c', 1_500), {
    waitingUntil: undefined,
    openDiff: false,
    closeDiff: true,
  });
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

test('routes survive being mounted under a subdirectory', () => {
  // GitHub project Pages serve the static preview from `/<repo>/`, so every
  // route the app writes and reads has to carry that prefix. The devtools
  // server keeps serving from `/`, which is the default everywhere else.
  const base = '/agent-devtools/';

  assert.equal(routeHref({ conversationId: 'conv_7', view: 'trace' }, base), '/agent-devtools/c/conv_7');
  assert.equal(
    routeHref({ conversationId: 'conv_7', view: 'network' }, base),
    '/agent-devtools/c/conv_7?view=network',
  );
  assert.equal(routeHref({ view: 'trace' }, base), '/agent-devtools/');

  assert.deepEqual(
    readRoute({ pathname: '/agent-devtools/c/conv_7', search: '?view=network' }, base),
    { conversationId: 'conv_7', view: 'network' },
  );
  assert.equal(readRoute({ pathname: '/agent-devtools/', search: '' }, base).conversationId, undefined);

  // The prefix is required, not optional: a bare `/c/<id>` under a based build
  // is some other application's URL, not a conversation this page can open.
  assert.equal(readRoute({ pathname: '/c/conv_7', search: '' }, base).conversationId, undefined);

  // And a based address must not resolve against the default mount.
  assert.equal(
    readRoute({ pathname: '/agent-devtools/c/conv_7', search: '' }, '/').conversationId,
    undefined,
  );
});

test('the trace is grouped into the HTTP exchanges it was rebuilt from', () => {
  // One captured turn: `r1` carried the prompt up and streamed a tool call
  // back; `r2` carried the result up and streamed the answer back.
  const exchanges = groupByRequest(
    groupTrace([
      traceNode('system', { id: 's1', revealedByRequestId: 'r1', systemSource: 'prompt' }),
      traceNode('user', { id: 'u1', revealedByRequestId: 'r1', text: 'hi' }),
      traceNode('assistant', { id: 'a1', producedByRequestId: 'r1', text: 'checking' }),
      traceNode('tool_call', { id: 'c1', producedByRequestId: 'r1', toolUseId: 't1', toolName: 'Bash' }),
      traceNode('tool_result', { id: 'x1', revealedByRequestId: 'r2', toolUseId: 't1' }),
      traceNode('assistant', { id: 'a2', producedByRequestId: 'r2', text: 'done' }),
    ]),
  );

  assert.deepEqual(
    exchanges.map((exchange) => exchange.requestId),
    ['r1', 'r2'],
  );
  // The result stays inside the turn that called the tool, so `r1`'s block is
  // the prompt, the answer and the whole tool round.
  assert.deepEqual(exchanges[0]?.items.map((item) => item.key), ['s1', 'u1', 'turn:a1']);
  assert.deepEqual(exchanges[1]?.items.map((item) => item.key), ['turn:a2']);

  // A node that names no request keeps its place rather than being folded into
  // the exchange beside it — a boundary there would be invented.
  const orphaned = groupByRequest(groupTrace([traceNode('user', { id: 'u9', text: 'hi' })]));
  assert.deepEqual(orphaned.map((exchange) => exchange.requestId), [undefined]);
});

test('a request carrying only a tool result keeps its HTTP exchange boundary', () => {
  const sections = groupTraceSections([
    traceNode('user', { id: 'prompt', text: 'run it', revealedByRequestId: 'r1' }),
    traceNode('tool_call', {
      id: 'call',
      producedByRequestId: 'r1',
      toolUseId: 't1',
      toolName: 'Bash',
    }),
    // This is the entire new tail of r2's request history. It is rendered in
    // r1's tool card, but r2 is still a real POST and must not become a
    // response-only block merely because its request row is visually folded.
    traceNode('tool_result', {
      id: 'result',
      revealedByRequestId: 'r2',
      toolUseId: 't1',
    }),
    traceNode('thinking', { id: 'thinking', producedByRequestId: 'r2' }),
    traceNode('tool_call', {
      id: 'next-call',
      producedByRequestId: 'r2',
      toolUseId: 't2',
      toolName: 'Read',
    }),
  ]);

  assert.deepEqual(
    sections.map((section) =>
      section.type === 'exchange'
        ? [section.exchange.requestId, section.exchange.phase]
        : ['background'],
    ),
    [
      ['r1', 'complete'],
      ['r2', 'complete'],
    ],
  );

  const first = sections[0];
  assert.equal(first?.type, 'exchange');
  if (first?.type !== 'exchange') return;
  const toolTurn = first.exchange.items.find((item) => item.type === 'turn');
  assert.equal(toolTurn?.type === 'turn' ? toolTurn.tools[0]?.result?.id : undefined, 'result');

  const second = sections[1];
  assert.equal(second?.type, 'exchange');
  if (second?.type !== 'exchange') return;
  assert.deepEqual(
    second.exchange.items.map((item) => item.type),
    ['tool_result_input', 'node', 'turn'],
    'r2 visibly projects the result it sent while r1 keeps the lifecycle card',
  );
});

test('only the external-link icon opens a projected tool result', () => {
  const node = traceNode('tool_result', {
    id: 'result',
    revealedByRequestId: 'r2',
    toolUseId: 't1',
    toolName: 'Bash',
    toolResult: 'ok',
  });

  const html = renderToStaticMarkup(
    createElement(ToolResultInputRow, {
      node,
      selected: false,
      onInspect: () => {},
    }),
  );
  assert.match(
    html,
    /<div data-tool-result-input=""[^>]*>.*?<button[^>]*aria-label="Inspect tool result from Bash"/s,
    'the result summary is a non-interactive container with a dedicated inspect button',
  );
  assert.match(html, /lucide-external-link/, 'the inspect button uses the external-link icon');
});

test('the chat trace combines only adjacent request and response phases', () => {
  const sections = groupTraceSections([
    traceNode('user', { id: 'earlier-prompt', text: 'first', revealedByRequestId: 'r0' }),
    traceNode('assistant', { id: 'earlier-answer', text: 'done', producedByRequestId: 'r0' }),
    traceNode('user', { id: 'quota', text: 'quota', sideCall: true, revealedByRequestId: 'r1' }),
    traceNode('user', { id: 'title', text: 'title', sideCall: true, revealedByRequestId: 'r2' }),
    traceNode('system', { id: 'system', text: 'rules', revealedByRequestId: 'r3' }),
    traceNode('user', { id: 'prompt', text: 'hello', revealedByRequestId: 'r3' }),
    traceNode('assistant', { id: 'answer', text: 'hi', producedByRequestId: 'r3' }),
    // Concurrent side-call responses finish after the ordinary turn. They must
    // render here, not be pulled back underneath their earlier request nodes.
    traceNode('assistant', {
      id: 'quota-answer',
      text: 'limit reached',
      sideCall: true,
      producedByRequestId: 'r1',
    }),
    traceNode('assistant', {
      id: 'title-answer',
      text: 'A title',
      sideCall: true,
      producedByRequestId: 'r2',
    }),
  ]);

  assert.deepEqual(
    sections.map((section) =>
      section.type === 'background'
        ? [
            'background',
            section.exchanges.map((exchange) => [exchange.requestId, exchange.phase]),
          ]
        : ['exchange', section.exchange.requestId, section.exchange.phase],
    ),
    [
      ['exchange', 'r0', 'complete'],
      ['background', [['r1', 'request'], ['r2', 'request']]],
      ['exchange', 'r3', 'complete'],
      ['background', [['r1', 'response'], ['r2', 'response']]],
    ],
  );
  assert.deepEqual(
    sections
      .filter((section) => section.type === 'background')
      .map((section) => section.exchanges.map((exchange) => exchange.items.length)),
    [
      [1, 1],
      [1, 1],
    ],
  );
});

test('background activity presents request outcomes as one compact summary without duration', () => {
  const nodes = [
    traceNode('user', { id: 'quota', text: 'quota prompt', sideCall: true, revealedByRequestId: 'r1' }),
    traceNode('user', { id: 'title', text: 'title prompt', sideCall: true, revealedByRequestId: 'r2' }),
    traceNode('assistant', { id: 'quota-response', text: 'no', sideCall: true, producedByRequestId: 'r1' }),
    traceNode('assistant', { id: 'title-response', text: 'done', sideCall: true, producedByRequestId: 'r2' }),
    traceNode('user', { id: 'prompt', text: 'hello', revealedByRequestId: 'r3' }),
  ];
  const transport = [
    {
      id: 'r1', provider: 'anthropic' as const, kind: 'utility' as const, method: 'POST',
      path: '/v1/messages', status: 429, isStream: false, startedAt: 1, durationMs: 477,
      requestBytes: 1, responseBytes: 1, conversationId: 'c1', turnIndex: 0,
    },
    {
      id: 'r2', provider: 'anthropic' as const, kind: 'utility' as const, method: 'POST',
      path: '/v1/messages', status: 200, isStream: false, startedAt: 2, durationMs: 2_130,
      requestBytes: 1, responseBytes: 1, conversationId: 'c1', turnIndex: 1,
    },
    {
      id: 'r3', provider: 'anthropic' as const, kind: 'conversation' as const, method: 'POST',
      path: '/v1/messages', status: 200, isStream: false, startedAt: 3, durationMs: 4_410,
      requestBytes: 1, responseBytes: 1, conversationId: 'c1', turnIndex: 2,
    },
  ];

  const background = groupTraceSections(nodes).find((section) => section.type === 'background');
  assert.ok(background);
  assert.deepEqual(summarizeBackgroundActivity(background.exchanges, transport), {
    requestCount: 2,
    errorCount: 1,
    pendingCount: 0,
  });
  assert.equal(
    formatBackgroundActivitySummary(
      summarizeBackgroundActivity(background.exchanges, transport),
    ),
    '2 requests, 1 error',
  );
});

test('an exchange labels its request and response as separate numbered phases', () => {
  const [exchange] = groupByRequest(
    groupTrace([
      traceNode('user', { id: 'prompt', text: 'hello', revealedByRequestId: 'r3' }),
      traceNode('assistant', { id: 'answer', text: 'hi', producedByRequestId: 'r3' }),
    ]),
  );
  assert.ok(exchange);

  const phases = splitExchangePhases(exchange);
  assert.deepEqual(phases.request.map((item) => item.key), ['prompt']);
  assert.deepEqual(phases.response.map((item) => item.key), ['turn:answer']);
  assert.equal(labelExchangePhase(2, 'request'), '#3 REQUEST');
  assert.equal(labelExchangePhase(2, 'response'), '#3 RESPONSE');
  assert.equal(labelExchangePhase(3, 'complete'), '#4');
  assert.equal(inspectorTabForPhase('request'), 'payload');
  assert.equal(inspectorTabForPhase('complete'), 'payload');
  assert.equal(inspectorTabForPhase('response'), 'response');
  assert.deepEqual(exchangeHeaderFields('request'), {
    methodAndPath: true,
    statusAndDuration: true,
  });
  assert.deepEqual(exchangeHeaderFields('response'), {
    methodAndPath: false,
    statusAndDuration: false,
  });
  assert.deepEqual(exchangeHeaderFields('complete'), {
    methodAndPath: true,
    statusAndDuration: true,
  });
});

test('trace number filters accept flexible separators and remove duplicates', () => {
  assert.deepEqual(parseTraceFilterNumbers('2'), [2]);
  assert.deepEqual(parseTraceFilterNumbers('11,2'), [11, 2]);
  assert.deepEqual(parseTraceFilterNumbers('3, 4, 5, 3'), [3, 4, 5]);
  assert.deepEqual(parseTraceFilterNumbers('3 4，5'), [3, 4, 5]);
  assert.equal(formatTraceFilterInput('11,2'), '11, 2');
});

test('trace filter completion starts the next number without a typed comma', () => {
  assert.equal(completeTraceFilterInput('11'), '11, ');
  assert.equal(completeTraceFilterInput('11, '), '11, ');
  assert.equal(completeTraceFilterInput(''), '');
});

test('trace filtering follows captured order rather than query order', () => {
  const sections = groupTraceSections([
    traceNode('user', { id: 'prompt-2', text: 'second', revealedByRequestId: 'r2' }),
    traceNode('assistant', { id: 'answer-2', text: 'two', producedByRequestId: 'r2' }),
    traceNode('user', { id: 'prompt-11', text: 'eleventh', revealedByRequestId: 'r11' }),
    traceNode('assistant', { id: 'answer-11', text: 'eleven', producedByRequestId: 'r11' }),
  ]);
  const transport = [
    {
      id: 'r2', provider: 'anthropic' as const, kind: 'conversation' as const, method: 'POST',
      path: '/v1/messages', status: 200, isStream: false, startedAt: 1, durationMs: 10,
      requestBytes: 1, responseBytes: 1, conversationId: 'c1', turnIndex: 1,
    },
    {
      id: 'r11', provider: 'anthropic' as const, kind: 'conversation' as const, method: 'POST',
      path: '/v1/messages', status: 200, isStream: false, startedAt: 2, durationMs: 10,
      requestBytes: 1, responseBytes: 1, conversationId: 'c1', turnIndex: 10,
    },
  ];

  const filtered = filterTraceSections(
    sections,
    transport,
    parseTraceFilterNumbers('11, 2'),
  );

  assert.deepEqual(
    filtered.flatMap((section) =>
      section.type === 'exchange'
        ? [section.exchange.requestId]
        : section.exchanges.map((exchange) => exchange.requestId),
    ),
    ['r2', 'r11'],
  );
});

test('greeking draws one bar per line, scaled to the longest line', () => {
  // 60 chars is the longest, so it fills the bar; the 30-char line is half of
  // it; the blank line keeps its row at zero width.
  const widths = greekLines(['x'.repeat(60), 'y'.repeat(30), '', 'z'.repeat(15)].join('\n'));
  assert.deepEqual(widths, [1, 0.5, 0, 0.25]);
});

test('greeking measures short sources against a floor, not against themselves', () => {
  // Without the floor these two 4-char lines would each normalise to a full-width
  // bar, drawing a stub tag exactly like a wall of prose.
  const widths = greekLines('abcd\nabcd');
  assert.ok(widths.every((width) => width < 0.2));
});

test('greeking samples the whole source, not its opening lines', () => {
  // Two documents sharing a 30-line preamble must not draw identically.
  const preamble = Array.from({ length: 30 }, () => 'shared line').join('\n');
  const short = greekLines(preamble);
  const long = greekLines(`${preamble}\n${'tail '.repeat(20)}`);
  assert.notDeepEqual(short, long);
});

test('greeking caps its bar count however long the source is', () => {
  const widths = greekLines(Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n'));
  assert.ok(widths.length > 0 && widths.length <= 14);
});

test('greeking ignores a trailing newline and yields nothing for empty text', () => {
  assert.deepEqual(greekLines('only\n'), greekLines('only'));
  assert.deepEqual(greekLines(''), []);
});

test('greeking keeps line lengths and discards everything else', () => {
  // The tray sits on screen across conversations, so what it draws must depend
  // on the shape of a source and on nothing else in it. Same lengths, entirely
  // different characters, identical output.
  const secret = greekLines('sk-ant-api03-0123456789\nAuthorization: Bearer xyz');
  const harmless = greekLines('aaaaaaaaaaaaaaaaaaaaaaa\nbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.deepEqual(secret, harmless);
});

test('the diff tray shows a chosen side beside a slot still waiting', () => {
  toggleGitDiffSource('left', {
    sourceId: 'node-1',
    sessionId: 'c1',
    label: 'system prompt',
    text: 'You are an agent.\n\nFollow the rules.',
    format: 'markdown',
  });
  try {
    const html = renderToStaticMarkup(createElement(DiffTray));
    assert.match(html, /system prompt/);
    // The unfilled side is drawn and named, not omitted — that asymmetry is the
    // whole signal the tray exists to carry.
    assert.match(html, /No source chosen for Diff Right/);
    // Shape only: the tray must never put the captured text on screen.
    assert.doesNotMatch(html, /You are an agent/);
  } finally {
    clearGitDiff();
  }
});

test('the diff tray stays out of the way when there is nothing pending', () => {
  clearGitDiff();
  assert.equal(renderToStaticMarkup(createElement(DiffTray)), '');
});

test('closing the diff keeps the origin its entrance used', () => {
  const Probe = () => createElement('i', null, useGitDiff().origin);
  const origin = () => renderToStaticMarkup(createElement(Probe)).replace(/<\/?i>/g, '');

  setGitDiffOpen(true, 'tray');
  assert.equal(origin(), 'tray');
  // The exit retraces the entrance. Reset it on close and a dialog that grew
  // out of the tray's corner would collapse into the middle of the screen.
  setGitDiffOpen(false);
  assert.equal(origin(), 'tray');

  // Every other route has no corner to come from and must not inherit one.
  setGitDiffOpen(true);
  assert.equal(origin(), 'elsewhere');
  setGitDiffOpen(false);
});
