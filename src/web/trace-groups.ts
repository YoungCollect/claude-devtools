import type { TraceNode, TransportSummary } from '../core/types.js';

/** One tool invocation and the result that came back for it. */
export interface ToolActivity {
  /** Stable render key: the provider's tool_use id when known, else the node id. */
  id: string;
  call?: TraceNode;
  result?: TraceNode;
}

/**
 * One response's worth of assistant output: the text blocks it streamed, plus
 * every tool it called and what those calls returned.
 */
export interface TraceTurn {
  type: 'turn';
  key: string;
  /** The request whose response produced this turn, when it had one. */
  requestId?: string;
  /** Assistant text blocks, in the order they were streamed. */
  messages: TraceNode[];
  tools: ToolActivity[];
}

/** Request-side projection of a result that is also shown with its originating call. */
export interface ToolResultInput {
  type: 'tool_result_input';
  key: string;
  node: TraceNode;
}

export type TraceItem =
  | { type: 'node'; key: string; node: TraceNode }
  | ToolResultInput
  | TraceTurn;

/**
 * Folds a flat node list into the turns a reader thinks in.
 *
 * The trace stores what the wire showed: an assistant text block, then each
 * tool call as its own node, then — one HTTP request later — each result as
 * another. Rendered one row per node that is mostly bookkeeping: a turn that
 * called three tools becomes seven rows of chrome around a couple of lines of
 * actual content, and the conversation stops being legible as a conversation.
 *
 * A call and its result are joined by `tool_use_id`, and both attach to the
 * turn whose response emitted the call — which is what lets the UI collapse the
 * whole tool round into a single line.
 *
 * Nodes that belong to no turn (user messages, system prompts, context blocks,
 * thinking, banners) pass through untouched and keep their own rows. Side-call
 * nodes remain distinguishable here so `groupTraceSections` can fold their
 * complete exchanges into a discoverable background-activity section.
 *
 * An assistant block with no text is dropped here rather than by the caller:
 * this function is the single answer to "what does the trace show", and the tab
 * badge counts its result.
 */
export function groupTrace(nodes: readonly TraceNode[]): TraceItem[] {
  const items: TraceItem[] = [];
  const openActivities = new Map<string, ToolActivity>();
  /** The turn still being built, or undefined once something closed it. */
  let current: TraceTurn | undefined;

  const startTurn = (node: TraceNode): TraceTurn => {
    const turn: TraceTurn = {
      type: 'turn',
      key: `turn:${node.id}`,
      requestId: node.producedByRequestId,
      messages: [],
      tools: [],
    };
    items.push(turn);
    current = turn;
    return turn;
  };

  /**
   * Turns are found by adjacency, not by request id.
   *
   * Request id alone looks right and fails on the case that matters: nodes
   * recovered from a request's *history* — everything the proxy missed by
   * attaching mid-conversation — carry `revealedByRequestId` and no
   * `producedByRequestId`, so a whole replayed transcript would either
   * fragment into one turn per node or collapse into a single turn covering
   * the entire conversation, depending on which id you keyed on.
   *
   * Adjacency handles both. A turn extends while the nodes keep coming from
   * the same response, and closes when the response changes, when assistant
   * text follows tool calls (that text is the *next* response answering them),
   * or when any non-turn node — a user message, a banner — interrupts.
   */
  const turnFor = (node: TraceNode): TraceTurn => {
    if (!current) return startTurn(node);
    if (current.requestId !== node.producedByRequestId) return startTurn(node);
    if (node.kind === 'assistant' && current.tools.length > 0) return startTurn(node);
    return current;
  };

  for (const node of nodes) {
    // The API emits an assistant node as soon as a block opens; until the first
    // delta lands it has nothing to render.
    if (node.kind === 'assistant' && !(node.text ?? '').trim()) continue;

    switch (node.kind) {
      case 'assistant':
        turnFor(node).messages.push(node);
        break;

      case 'tool_call': {
        // A captured response is the authoritative occurrence of a call. Older
        // reconstruction state may also contain the assistant-history replay
        // from the next request when Claude Code normalized its input before
        // resending it. Keep that replay available in the Inspector through
        // its request body, but do not let a second trace node replace the
        // original activity and steal the result association.
        const existing = node.toolUseId ? openActivities.get(node.toolUseId) : undefined;
        if (existing?.call?.producedByRequestId && !node.producedByRequestId) break;

        const activity: ToolActivity = { id: node.toolUseId ?? node.id, call: node };
        turnFor(node).tools.push(activity);
        if (node.toolUseId) openActivities.set(node.toolUseId, activity);
        break;
      }

      case 'tool_result': {
        // Results arrive on a later request than their call, so they are matched
        // by id rather than by position, and they never open or close a turn.
        const pending = node.toolUseId ? openActivities.get(node.toolUseId) : undefined;
        if (pending) {
          pending.result = node;
          if (node.toolUseId) openActivities.delete(node.toolUseId);
          break;
        }
        // A result whose call we never saw — the proxy attached mid-conversation,
        // or retention dropped the earlier turn. It still has to be readable, so
        // it gets a turn of its own rather than being silently swallowed.
        items.push({
          type: 'turn',
          key: `turn:${node.id}`,
          messages: [],
          tools: [{ id: node.id, result: node }],
        });
        current = undefined;
        break;
      }

      default:
        items.push({ type: 'node', key: node.id, node });
        current = undefined;
    }
  }

  return items;
}

/**
 * One HTTP exchange's worth of the trace: everything a single captured request
 * either carried up or streamed back.
 */
export interface TraceExchange {
  key: string;
  /** The captured request this block belongs to, when the nodes name one. */
  requestId?: string;
  items: TraceItem[];
}

export interface ExchangePhases {
  request: TraceItem[];
  response: TraceItem[];
}

/**
 * Separates what was sent from what the model returned within one exchange.
 *
 * Request-history nodes name the exchange through `revealedByRequestId`;
 * streamed response nodes name it through `producedByRequestId`. Keeping that
 * distinction in the presentation model prevents an assistant response from
 * inheriting the request heading merely because both share one HTTP boundary.
 */
export function splitExchangePhases(exchange: TraceExchange): ExchangePhases {
  const phases: ExchangePhases = { request: [], response: [] };
  for (const item of exchange.items) {
    const nodes = traceItemNodes(item);
    const producedHere =
      exchange.requestId !== undefined &&
      (item.type === 'turn' && item.requestId === exchange.requestId ||
        nodes.some((node) => node.producedByRequestId === exchange.requestId));
    phases[producedHere ? 'response' : 'request'].push(item);
  }
  return phases;
}

export type ExchangePhase = keyof ExchangePhases;
export type TraceDisplayPhase = ExchangePhase | 'complete';

/** One chronological phase, or an adjacent request/response pair. */
export interface TracePhaseExchange extends TraceExchange {
  phase: TraceDisplayPhase;
}

/** The phase heading as it appears in Chat Trace. */
export function labelExchangePhase(
  turnIndex: number | undefined,
  phase: TraceDisplayPhase,
): string {
  const number = turnIndex === undefined ? '' : `#${turnIndex + 1}`;
  if (phase === 'complete') return number || 'EXCHANGE';
  return `${number ? `${number} ` : ''}${phase.toUpperCase()}`;
}

export interface ExchangeHeaderFields {
  methodAndPath: boolean;
  statusAndDuration: boolean;
}

/** Which transport summary fields accompany a Chat Trace heading. */
export function exchangeHeaderFields(phase: TraceDisplayPhase): ExchangeHeaderFields {
  const showSummary = phase !== 'response';
  return {
    methodAndPath: showSummary,
    statusAndDuration: showSummary,
  };
}

/** The Inspector tab opened by a Chat Trace exchange/phase magnifier. */
export function inspectorTabForPhase(
  phase: TraceDisplayPhase,
): 'payload' | 'response' {
  return phase === 'response' ? 'response' : 'payload';
}

/** Which request a rendered item came out of. */
function requestIdFor(item: TraceItem): string | undefined {
  if (item.type === 'node' || item.type === 'tool_result_input') {
    return item.node.producedByRequestId ?? item.node.revealedByRequestId;
  }
  const [first] = turnNodes(item);
  return item.requestId ?? first?.producedByRequestId ?? first?.revealedByRequestId;
}

/**
 * Folds the trace into the exchanges it was reconstructed from.
 *
 * The Network view makes the request boundaries obvious and the Chat Trace hid
 * them completely: reading it, there was no way to tell which lines the agent
 * sent up in one body from which came back on the wire, or where one HTTP
 * round-trip ended and the next began. Both views describe the same traffic, so
 * the trace draws the same boundaries — one dashed block per request.
 *
 * Adjacent items sharing a request join one block, in trace order. A tool
 * result is deliberately *not* pulled into its own request's block: it is
 * already rendered inside the turn that called it (see `groupTrace`), and that
 * turn belongs to the response that made the call. So a block reads as "this
 * request, and what the model did with it".
 *
 * Items with no request — nothing produces them today, but a node restored from
 * a partial capture could — keep their place in the order and get a block with
 * no id, which the UI renders undecorated rather than inventing a boundary.
 */
export function groupByRequest(items: readonly TraceItem[]): TraceExchange[] {
  const exchanges: TraceExchange[] = [];
  for (const item of items) {
    const requestId = requestIdFor(item);
    const open = exchanges[exchanges.length - 1];
    if (open && open.requestId === requestId) {
      open.items.push(item);
      continue;
    }
    exchanges.push({
      // The first item's key is unique already, and stays stable as the block
      // grows — keying on the request id alone would collide for the
      // undefined case.
      key: `exchange:${item.key}`,
      ...(requestId !== undefined ? { requestId } : {}),
      items: [item],
    });
  }
  return exchanges;
}

export type TraceSection =
  | { type: 'exchange'; key: string; exchange: TracePhaseExchange }
  | { type: 'background'; key: string; exchanges: TracePhaseExchange[] };

/**
 * Builds the top-level rows visible in Chat Trace.
 *
 * An adjacent request and response become one compact exchange. A response
 * separated by concurrent traffic stays where its produced nodes occur;
 * request id links the phases for inspection but never relocates either one.
 * Consecutive side-call entries fold into a background section at that same
 * point in the timeline.
 */
export function groupTraceSections(nodes: readonly TraceNode[]): TraceSection[] {
  const phases: TracePhaseExchange[] = groupByRequest(groupTrace(nodes)).flatMap((exchange) => {
    const itemsByPhase = splitExchangePhases(exchange);
    return (Object.keys(itemsByPhase) as ExchangePhase[]).flatMap((phase) => {
      const items = itemsByPhase[phase];
      return items.length > 0
        ? [{ ...exchange, key: `${exchange.key}:${phase}`, phase, items }]
        : [];
    });
  });

  /*
   * A matched tool result is rendered inside the response turn that issued the
   * call. That is the readable conversation view, but it must not erase the
   * next HTTP request that carried the result back to the model. Restore an
   * request-phase shell for every revealed request whose only visible nodes
   * were folded into an earlier tool card. Tool results then project into the
   * shell below, and an adjacent response merges with it into the same compact
   * complete exchange as an ordinary request/response pair.
   */
  const requestPhases = new Map(
    phases.flatMap((exchange) =>
      exchange.phase === 'request' && exchange.requestId
        ? [[exchange.requestId, exchange] as const]
        : [],
    ),
  );
  const revealedRequestIds = new Set(
    nodes.flatMap((node) => (node.revealedByRequestId ? [node.revealedByRequestId] : [])),
  );
  for (const requestId of revealedRequestIds) {
    if (requestPhases.has(requestId)) continue;
    const shell: TracePhaseExchange = {
      key: `exchange:request-shell:${requestId}`,
      requestId,
      phase: 'request',
      items: [],
    };
    phases.push(shell);
    requestPhases.set(requestId, shell);
  }

  // A tool result answers two useful questions at once. Its lifecycle belongs
  // beside the call that launched it, while its transport role belongs in the
  // next request that sent it back to the model. Project it into that request
  // without cloning the node or removing it from the originating tool card.
  for (const node of nodes) {
    if (node.kind !== 'tool_result' || !node.revealedByRequestId) continue;
    const request = requestPhases.get(node.revealedByRequestId);
    if (!request) continue;
    const alreadyVisible = request.items.some((item) =>
      traceItemNodes(item).some((candidate) => candidate.id === node.id),
    );
    if (alreadyVisible) continue;
    request.items.push({
      type: 'tool_result_input',
      key: `tool-result-input:${node.id}`,
      node,
    });
  }

  // Shells are created after grouping, so put every phase back at the point
  // where its own request/response nodes first appeared. This also preserves
  // real concurrent ordering: a late side-call response stays late.
  const nodeOrder = new Map<string, number>();
  const firstRevealed = new Map<string, number>();
  const firstProduced = new Map<string, number>();
  nodes.forEach((node, index) => {
    nodeOrder.set(node.id, index);
    if (node.revealedByRequestId && !firstRevealed.has(node.revealedByRequestId)) {
      firstRevealed.set(node.revealedByRequestId, index);
    }
    if (node.producedByRequestId && !firstProduced.has(node.producedByRequestId)) {
      firstProduced.set(node.producedByRequestId, index);
    }
  });
  const itemAnchor = (item: TraceItem): number =>
    Math.min(
      ...traceItemNodes(item).map(
        (node) => nodeOrder.get(node.id) ?? Number.MAX_SAFE_INTEGER,
      ),
      Number.MAX_SAFE_INTEGER,
    );
  for (const phase of phases) phase.items.sort((left, right) => itemAnchor(left) - itemAnchor(right));

  const phaseAnchor = (exchange: TracePhaseExchange): number => {
    if (exchange.requestId) {
      const requestOrder =
        exchange.phase === 'request'
          ? firstRevealed.get(exchange.requestId)
          : firstProduced.get(exchange.requestId);
      if (requestOrder !== undefined) return requestOrder;
    }
    const itemNodes = exchange.items.flatMap(traceItemNodes);
    return Math.min(
      ...itemNodes.map((node) => nodeOrder.get(node.id) ?? Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER,
    );
  };
  phases.sort((left, right) => phaseAnchor(left) - phaseAnchor(right));

  const displayExchanges: TracePhaseExchange[] = [];
  for (const exchange of phases) {
    const request = displayExchanges[displayExchanges.length - 1];
    if (
      request?.phase === 'request' &&
      exchange.phase === 'response' &&
      request.requestId !== undefined &&
      request.requestId === exchange.requestId
    ) {
      displayExchanges[displayExchanges.length - 1] = {
        ...request,
        key: `${request.key}:complete`,
        phase: 'complete',
        items: [...request.items, ...exchange.items],
      };
      continue;
    }
    displayExchanges.push(exchange);
  }

  const sections: TraceSection[] = [];
  for (const exchange of displayExchanges) {
    if (!isBackgroundExchange(exchange)) {
      sections.push({ type: 'exchange', key: exchange.key, exchange });
      continue;
    }

    const open = sections[sections.length - 1];
    if (open?.type === 'background') {
      open.exchanges.push(exchange);
    } else {
      sections.push({
        type: 'background',
        key: `background:${exchange.key}`,
        exchanges: [exchange],
      });
    }
  }
  return sections;
}

export interface BackgroundActivitySummary {
  requestCount: number;
  errorCount: number;
  pendingCount: number;
}

/** Derives the compact header shown for a background-activity section. */
export function summarizeBackgroundActivity(
  exchanges: readonly TraceExchange[],
  transport: readonly TransportSummary[],
): BackgroundActivitySummary {
  const requestsById = new Map(transport.map((request) => [request.id, request]));
  const requestIds = new Set(
    exchanges.flatMap((exchange) => (exchange.requestId ? [exchange.requestId] : [])),
  );
  const requests = [...requestIds].flatMap((requestId) => {
    const request = requestsById.get(requestId);
    return request ? [request] : [];
  });
  return {
    requestCount: requestIds.size + exchanges.filter((exchange) => !exchange.requestId).length,
    errorCount: requests.filter((request) => request.error || (request.status ?? 0) >= 400).length,
    pendingCount: requests.filter(
      (request) => !request.error && request.status === undefined,
    ).length,
  };
}

/** Formats all background outcomes as one header badge. */
export function formatBackgroundActivitySummary(
  summary: BackgroundActivitySummary,
): string {
  const parts = [
    `${summary.requestCount} ${summary.requestCount === 1 ? 'request' : 'requests'}`,
  ];
  if (summary.errorCount > 0) {
    parts.push(`${summary.errorCount} ${summary.errorCount === 1 ? 'error' : 'errors'}`);
  }
  if (summary.pendingCount > 0) {
    parts.push(`${summary.pendingCount} pending`);
  }
  return parts.join(', ');
}

function isBackgroundExchange(exchange: TraceExchange): boolean {
  const nodes = exchange.items.flatMap(traceItemNodes);
  return nodes.length > 0 && nodes.every((node) => node.sideCall === true);
}

/** Every node carried by a presentation item, including request projections. */
function traceItemNodes(item: TraceItem): TraceNode[] {
  return item.type === 'turn' ? turnNodes(item) : [item.node];
}

/** Every node a turn renders, for selection and drill-down. */
export function turnNodes(turn: TraceTurn): TraceNode[] {
  const nodes = [...turn.messages];
  for (const { call, result } of turn.tools) {
    if (call) nodes.push(call);
    if (result) nodes.push(result);
  }
  return nodes;
}
