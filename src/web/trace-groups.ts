import type { TraceNode } from '../core/types.js';

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

export type TraceItem = { type: 'node'; key: string; node: TraceNode } | TraceTurn;

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
 * thinking, banners) pass through untouched and keep their own rows.
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

/** Every node a turn renders, for selection and drill-down. */
export function turnNodes(turn: TraceTurn): TraceNode[] {
  const nodes = [...turn.messages];
  for (const { call, result } of turn.tools) {
    if (call) nodes.push(call);
    if (result) nodes.push(result);
  }
  return nodes;
}
