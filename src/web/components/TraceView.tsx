import { createContext, useContext, useMemo, useState } from 'react';
import { ExternalLink, Search, UserRound } from 'lucide-react';
import { agentForProvider, BrandMark, useAgent } from '../agent.js';
import { splitTaggedUserContent } from '../../core/tagged-content.js';
import { hasXmlStructure } from '../../core/xml-outline.js';
import { ContentToolbar, type ContentToolbarProps } from './ContentToolbar.js';
import { ToolResultInputRow } from './ToolResultInputRow.js';
import {
  ContentViewer,
  diffFormatFor,
  useContentViewMode,
  type ContentFormat,
} from './ContentViewer.js';
import { DataSurface, DataSurfaceBody } from './DataSurface.js';
import type { GitDiffFormat, GitDiffSourceIdentity } from '../git-diff.js';
import type { ProviderId, TraceNode, TransportSummary } from '../../core/types.js';
import {
  exchangeHeaderFields,
  formatBackgroundActivitySummary,
  groupTraceSections,
  inspectorTabForPhase,
  labelExchangePhase,
  summarizeBackgroundActivity,
  type ToolActivity,
  type TraceDisplayPhase,
  type TraceItem,
  type TracePhaseExchange,
  type TraceTurn,
} from '../trace-groups.js';
import { formatMs, formatTokens, pretty, toolResultText, truncate } from '../format.js';
import { filterTraceSections } from '../trace-filter.js';
import { Chevron, cx, Empty, MetaBadge, StatusBadge, TagLabel, type RoleTone } from './ui.js';

/**
 * Chat turns are prose. Module-level so every bubble shares one array — the
 * viewer memoises its mode list on this identity, and a literal rebuilt per
 * render would defeat that on every streamed frame.
 */
const PROSE_FORMATS: ContentFormat[] = ['markdown'];

/**
 * The Chat Trace shows rendered text only — its `Rendered · MD` / `Rendered ·
 * XML` / `Raw` toggle is hidden on every panel below.
 *
 * Copy already yields the exact source, so the toggle was a second route to
 * bytes you can already take, paid for with two extra controls on every turn in
 * a view whose job is reading the conversation. The Inspector's system prompt
 * makes the same trade, and its Raw tab shows the whole request verbatim.
 *
 * Flip this to `true` to bring the toggle back on the panels that draw their
 * own control row — the system and context blocks, the ones with two rendered
 * views to switch between. The chat bubbles' row is built by `TurnControls`
 * below and is diff plus copy either way: a turn has one rendered view.
 */
const SHOW_CHAT_VIEW_MODES = false;

export interface TraceViewProps {
  nodes: TraceNode[];
  /** The provider this conversation was captured from, when it is known. */
  provider?: ProviderId;
  /**
   * The captured requests for this conversation, so each block can name the
   * exchange it was rebuilt from. Absent while the snapshot is still loading —
   * the blocks draw either way, just without their summary line.
   */
  transport?: readonly TransportSummary[];
  /** One-based exchange numbers selected in the header filter. */
  filterNumbers?: readonly number[];
  selectedNodeId?: string;
  /** The exchange the Inspector is currently open on, whichever view opened it. */
  selectedRequestId?: string;
  onInspect: (node: TraceNode) => void;
  /** Opens the Inspector on a whole exchange/phase rather than on one node. */
  onInspectRequest?: (transportId: string, tab: 'payload' | 'response') => void;
}

/**
 * The Chat Trace: the agent's run as a developer reads it, in the order it
 * happened. Exchange headers are the general transport drill-down; system and
 * context pills additionally link to the exact body field they came from.
 *
 * Adjacent request/response phases share one dashed block. When concurrent
 * traffic separates them, each phase keeps its node position and gets its own
 * block rather than pulling the response backward under its request.
 */
export function TraceView({
  nodes,
  provider,
  transport,
  filterNumbers = [],
  selectedNodeId,
  selectedRequestId,
  onInspect,
  onInspectRequest,
}: TraceViewProps) {
  // Grouping walks the whole list, so it must not re-run per streamed frame.
  // store bumps its revision on every streamed frame.
  const allSections = useMemo(() => groupTraceSections(nodes), [nodes]);
  const sections = useMemo(
    () => filterTraceSections(allSections, transport ?? [], filterNumbers),
    [allSections, transport, filterNumbers],
  );
  const requestsById = useMemo(
    () => new Map((transport ?? []).map((record) => [record.id, record])),
    [transport],
  );

  if (allSections.length === 0) {
    return <Empty>No trace events yet. Point an agent at the proxy and send a message.</Empty>;
  }
  if (sections.length === 0) {
    return <Empty>No exchanges match this filter.</Empty>;
  }
  return (
    <ConversationProvider.Provider value={provider}>
      <div className="flex flex-col gap-3 p-3">
        {sections.map((section) =>
          section.type === 'background' ? (
            <BackgroundActivity
              key={section.key}
              exchanges={section.exchanges}
              requestsById={requestsById}
              selectedNodeId={selectedNodeId}
              selectedRequestId={selectedRequestId}
              onInspect={onInspect}
              onInspectRequest={onInspectRequest}
            />
          ) : (
            <ExchangeBlock
              key={section.key}
              exchange={section.exchange}
              request={
                section.exchange.requestId
                  ? requestsById.get(section.exchange.requestId)
                  : undefined
              }
              selected={
                section.exchange.requestId !== undefined &&
                section.exchange.requestId === selectedRequestId
              }
              selectedNodeId={selectedNodeId}
              onInspect={onInspect}
              onInspectRequest={onInspectRequest}
            />
          ),
        )}
      </div>
    </ConversationProvider.Provider>
  );
}

/**
 * The provider the open conversation came from, for the turns beneath it.
 *
 * Context rather than a prop threaded through five components: the only reader
 * is the assistant mark at the bottom of the tree, and every layer in between
 * would otherwise carry a value it has no use for.
 */
const ConversationProvider = createContext<ProviderId | undefined>(undefined);

function BackgroundActivity({
  exchanges,
  requestsById,
  selectedNodeId,
  selectedRequestId,
  onInspect,
  onInspectRequest,
}: {
  exchanges: TracePhaseExchange[];
  requestsById: ReadonlyMap<string, TransportSummary>;
  selectedNodeId?: string;
  selectedRequestId?: string;
  onInspect: (node: TraceNode) => void;
  onInspectRequest?: (transportId: string, tab: 'payload' | 'response') => void;
}) {
  const [open, setOpen] = useState(false);
  const requests = [...requestsById.values()];
  const summary = summarizeBackgroundActivity(exchanges, requests);

  return (
    <section className="rounded-xl border border-hairline bg-surface-soft">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-h-12 w-full items-center gap-2.5 px-4 py-2.5 text-left"
      >
        <span className="text-[11px] font-medium tracking-[1.5px] text-muted-foreground uppercase">
          Background activity
        </span>
        <MetaBadge tone="neutral">
          {formatBackgroundActivitySummary(summary)}
        </MetaBadge>
        <span className="ml-auto text-muted-foreground">
          <Chevron open={open} direction="right" />
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-hairline px-3 py-3">
          {exchanges.map((exchange) => (
            <ExchangeBlock
              key={exchange.key}
              exchange={exchange}
              request={exchange.requestId ? requestsById.get(exchange.requestId) : undefined}
              selected={exchange.requestId !== undefined && exchange.requestId === selectedRequestId}
              selectedNodeId={selectedNodeId}
              onInspect={onInspect}
              onInspectRequest={onInspectRequest}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One chronological phase or adjacent request/response pair, in a dashed frame.
 *
 * Dashed rather than solid: this is a boundary drawn around content, not
 * another card in a view that already nests cards two deep (turn → tool → pane).
 * Request headers carry method, path, status, and timing together; a standalone
 * response header only names its phase. The shared number lets both phases line
 * up with the Network row.
 */
function ExchangeBlock({
  exchange,
  request,
  selected,
  selectedNodeId,
  onInspect,
  onInspectRequest,
}: {
  exchange: TracePhaseExchange;
  request?: TransportSummary;
  selected: boolean;
  selectedNodeId?: string;
  onInspect: (node: TraceNode) => void;
  onInspectRequest?: (transportId: string, tab: 'payload' | 'response') => void;
}) {
  const renderRows = (items: readonly TraceItem[]) => (
    <div className="trace-stack flex flex-col divide-y divide-hairline-soft">
      {items.map((item) =>
        item.type === 'turn' ? (
          <TurnRow key={item.key} turn={item} />
        ) : item.type === 'tool_result_input' ? (
          <ToolResultInputRow
            key={item.key}
            node={item.node}
            selected={item.node.id === selectedNodeId}
            onInspect={onInspect}
          />
        ) : (
          <TraceRow
            key={item.key}
            node={item.node}
            selected={item.node.id === selectedNodeId}
            onInspect={onInspect}
          />
        ),
      )}
    </div>
  );

  // Nothing to frame: these rows name no request, so a boundary around them
  // would be a claim the capture cannot support.
  const requestId = exchange.requestId;
  if (!requestId) return renderRows(exchange.items);

  const label = labelExchangePhase(request?.turnIndex, exchange.phase);
  return (
    <section
      aria-label={`${label} ${exchange.phase !== 'response' ? request?.path ?? '' : ''}`.trim()}
      className={cx(
        'rounded-xl border border-dashed transition-colors',
        selected ? 'border-primary' : 'border-hairline',
      )}
    >
      <ExchangePhaseHeader
        phase={exchange.phase}
        request={request}
        requestId={requestId}
        onInspectRequest={onInspectRequest}
      />
      {renderRows(exchange.items)}
    </section>
  );
}

function ExchangePhaseHeader({
  phase,
  request,
  requestId,
  onInspectRequest,
}: {
  phase: TraceDisplayPhase;
  request?: TransportSummary;
  requestId: string;
  onInspectRequest?: (transportId: string, tab: 'payload' | 'response') => void;
}) {
  const fields = exchangeHeaderFields(phase);
  const label = labelExchangePhase(request?.turnIndex, phase);
  return (
    <div
      className="flex items-center gap-2.5 border-b border-dashed border-hairline px-4 py-2"
    >
      <span className="shrink-0 text-[11px] font-medium tracking-[1.5px] text-muted-soft uppercase">
        {label}
      </span>
      {fields.methodAndPath && request && (
        <span className="truncate font-mono text-[12px] text-muted-foreground">
          {request.method} {request.path}
        </span>
      )}
      {fields.statusAndDuration && request && (
        <>
          {request.error ? (
            <StatusBadge tone="error">err</StatusBadge>
          ) : request.status === undefined ? (
            <StatusBadge tone="warning" title="Still open through the proxy">
              …
            </StatusBadge>
          ) : (
            <StatusBadge tone={request.status >= 400 ? 'error' : 'success'}>
              {request.status}
            </StatusBadge>
          )}
          {request.durationMs !== undefined && (
            <span className="shrink-0 font-mono text-[12px] text-muted-soft" title="total time">
              {formatMs(request.durationMs)}
            </span>
          )}
        </>
      )}
      {onInspectRequest && (
        <button
          type="button"
          onClick={() => onInspectRequest(requestId, inspectorTabForPhase(phase))}
          aria-label={`Inspect ${label}`}
          title={`Inspect ${label}`}
          className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-md text-primary outline-none hover:bg-surface-soft focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <Search size={14} strokeWidth={2} aria-hidden />
        </button>
      )}
    </div>
  );
}

/**
 * One assistant response: its text, then everything it did, folded away.
 *
 * The tool round is collapsed because it is the bulk of a run by volume and the
 * minority of it by interest — you scan a trace to follow the conversation and
 * open the tools when something looks wrong. Measured on a two-turn capture,
 * tool rows were 30% of the trace's height for one command and eight lines of
 * output.
 */
function TurnRow({ turn }: { turn: TraceTurn }) {
  return (
    <div
      data-trace-row=""
      data-trace-kind="message"
      className={cx(
        'flex w-full justify-start border-l-2 border-transparent px-4 pt-4',
        turn.tools.length > 0 ? 'pb-2' : 'pb-0',
      )}
    >
      <div className="min-w-0 flex-1">
        {turn.messages.map((node) => (
          <AssistantNode key={node.id} node={node} />
        ))}
        {turn.tools.length > 0 && (
          <div className={turn.messages.length > 0 ? 'mt-3' : undefined}>
            <ToolStrip activities={turn.tools} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The turn's tool round, one line until asked.
 *
 * Collapsed it counts what ran; opened it shows each call's full input and full
 * result. The full input is new here — the old single-node row only ever showed
 * `summarizeToolInput`'s one-line gist, so the actual arguments were reachable
 * only through the Inspector.
 */
function ToolStrip({ activities }: { activities: ToolActivity[] }) {
  const [open, setOpen] = useState(false);
  const failed = activities.filter(({ result }) => result?.isError).length;
  const pending = activities.filter(({ result }) => result === undefined).length;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 text-left"
      >
        <TagLabel role="tool" size="control" className="w-24 justify-between">
          {activities.length === 1 ? '1 tool' : `${activities.length} tools`}
          <Chevron open={open} direction="right" />
        </TagLabel>
        {failed > 0 && <StatusBadge tone="error">{failed} failed</StatusBadge>}
        {pending > 0 && <StatusBadge tone="warning">{pending} pending</StatusBadge>}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {activities.map((activity) => (
            <ToolActivityCard key={activity.id} activity={activity} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolActivityCard({ activity }: { activity: ToolActivity }) {
  const { call, result } = activity;
  const name = call?.toolName ?? result?.toolName ?? 'tool';

  return (
    <div className="rounded-lg border border-hairline">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span className="text-[14px] font-medium text-ink">{name}</span>
        {call?.durationMs !== undefined && (
          <span className="font-mono text-[12px] text-muted-soft" title="model time to emit this call">
            {formatMs(call.durationMs)}
          </span>
        )}
        {result?.isError && <StatusBadge tone="error">error</StatusBadge>}
        {result?.durationMs !== undefined && (
          <MetaBadge
            tone="warning"
            title={
              result.durationIsBatch
                ? 'Wall time for the whole parallel tool batch — the agent ran several calls in this window'
                : 'Time between the end of the model response and the request carrying this result'
            }
          >
            tool {formatMs(result.durationMs)}
            {result.durationIsBatch ? ' · batch' : ''}
          </MetaBadge>
        )}
      </div>

      {call && (
        <ToolPane label="input" text={pretty(call.toolInput)} empty="No arguments" />
      )}
      {result ? (
        <ToolPane label="result" text={toolResultText(result.toolResult)} isError={result.isError} empty="(empty)" />
      ) : (
        <div className="px-3 pb-2.5 text-[12.5px] text-muted-soft italic">
          Still running — no result has come back yet.
        </div>
      )}
    </div>
  );
}

/**
 * Tool input and tool output are both machine text: a `DataSurface`, nested
 * one level in because these panes sit two deep inside the trace (row, then
 * tool card) — the same reason the Inspector's SSE frames and JSON tree take
 * `nested` for content one level inside their own block.
 */
function ToolPane({
  label,
  text,
  isError = false,
  empty,
}: {
  label: string;
  text: string;
  isError?: boolean;
  empty: string;
}) {
  return (
    <div className="px-3 pb-2.5">
      <div className="mb-1 text-[11px] font-medium tracking-[1.5px] text-muted-soft uppercase">
        {label}
      </div>
      <DataSurface variant="nested">
        <DataSurfaceBody maxHeightClass="max-h-[260px]">
          <pre
            className={cx(
              'px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] whitespace-pre-wrap',
              isError ? 'text-error-fg' : 'text-data-foreground-muted',
            )}
          >
            {text.trim() || empty}
          </pre>
        </DataSurfaceBody>
      </DataSurface>
    </div>
  );
}

function TraceRow({
  node,
  selected,
  onInspect,
}: {
  node: TraceNode;
  selected: boolean;
  onInspect: (node: TraceNode) => void;
}) {
  const rowKind =
    node.kind === 'system' || node.kind === 'context'
      ? 'context'
      : node.kind === 'user' || node.kind === 'assistant' || node.kind === 'error'
        ? 'message'
        : undefined;
  const messageHasControls =
    (node.kind === 'user' || node.kind === 'assistant') && Boolean(node.text);
  const rightAligned =
    node.kind === 'system' || node.kind === 'context' || node.kind === 'user';
  // System and context blocks hold rendered markdown and tag outlines. Those are
  // documents, not chat turns: constraining them to a bubble width reflows code
  // and tables for no reason, so they take the full column.
  const contentWidth =
    node.kind === 'user' || node.kind === 'assistant' ? 'max-w-[72%]' : 'w-full';
  return (
    <div
      data-trace-row={rowKind === undefined ? undefined : ''}
      data-trace-kind={rowKind}
      className={cx(
        'flex w-full border-transparent px-4 pt-4',
        rowKind === 'message' ? (messageHasControls ? 'pb-0' : 'pb-2') : 'pb-4',
        rightAligned ? 'justify-end border-r-2' : 'justify-start border-l-2',
      )}
    >
      <div className={cx('min-w-0', contentWidth)}>
        <NodeBody node={node} selected={selected} onInspect={onInspect} />
      </div>
    </div>
  );
}

function NodeBody({
  node,
  selected,
  onInspect,
}: {
  node: TraceNode;
  selected: boolean;
  onInspect: (node: TraceNode) => void;
}) {
  switch (node.kind) {
    case 'system':
      // A system prompt is a markdown document that happens to embed a few tag
      // blocks, so it leads with the prose view and offers the outline second.
      return (
        <ContextNode
          text={node.text ?? ''}
          label={node.systemSource === 'prompt' ? 'system prompt' : 'system'}
          sourceId={node.id}
          sessionId={node.conversationId}
          role="system"
          preferMarkdown
          selected={selected}
          onInspect={() => onInspect(node)}
        />
      );
    case 'context':
      return (
        <ContextNode
          text={node.text ?? ''}
          label={node.contextTag ?? 'context'}
          sourceId={node.id}
          sessionId={node.conversationId}
          role="context"
          selected={selected}
          onInspect={() => onInspect(node)}
        />
      );
    case 'user':
      return <UserNode node={node} />;
    case 'assistant':
      return <AssistantNode node={node} />;
    case 'thinking':
      return <ThinkingNode node={node} />;
    case 'compaction':
      return <BannerNode node={node} label="context" />;
    case 'error':
      return <ErrorNode node={node} />;
    default:
      return <ThinkingNode node={node} />;
  }
}

function UserNode({ node }: { node: TraceNode }) {
  const raw = node.text ?? '';
  const segments = splitTaggedUserContent(raw);
  if (segments.some(({ kind }) => kind === 'context')) {
    return (
      <div className="space-y-3">
        {segments.map((segment, index) =>
          segment.kind === 'context' ? (
            <ContextNode
              key={`${segment.contextTag ?? 'context'}-${index}`}
              text={segment.text}
              label={segment.contextTag ?? 'context'}
              sourceId={`${node.id}:context:${index}`}
              sessionId={node.conversationId}
            />
          ) : (
            <UserBubble
              key={`user-${index}`}
              text={segment.text}
              sourceId={`${node.id}:user:${index}`}
              sessionId={node.conversationId}
            />
          ),
        )}
      </div>
    );
  }

  return (
    <UserBubble
      text={segments[0]?.text ?? raw}
      sourceId={node.id}
      sessionId={node.conversationId}
    />
  );
}

function UserBubble({
  text,
  sourceId,
  sessionId,
}: {
  text: string;
  sourceId: string;
  sessionId: string;
}) {
  return (
    <div className="group/turn">
      <Gutter
        label={
          <>
            <UserRound size={18} aria-hidden />
            <span className="sr-only">User</span>
          </>
        }
        role="user"
        align="end"
        iconOnly
      />
      {text ? (
        <ContentViewer
          className="min-w-50 mt-1.5 rounded-2xl rounded-tr-sm border border-hairline bg-canvas px-4 py-3"
          variant="bare"
          text={text}
          formats={PROSE_FORMATS}
          maxHeightClass="max-h-none"
          proseClassName="markdown-chat markdown-lead"
          showViewModes={SHOW_CHAT_VIEW_MODES}
          controlsPlacement="external"
        />
      ) : (
        <div className="min-w-50 mt-1.5 rounded-2xl rounded-tr-sm border border-hairline bg-canvas px-4 py-3">
          <span className="display text-[17px] text-muted-soft italic">(no visible text)</span>
        </div>
      )}
      {text && (
        <TurnControls
          text={text}
          diffSource={{ sourceId, sessionId, label: 'user message' }}
          align="end"
          spacing="message"
        />
      )}
    </div>
  );
}

/**
 * A row's controls, under its block instead of inside it.
 *
 * This is the shape every chat interface has settled on, and the reason holds
 * for every block in the trace: the bubble — or the expanded system prompt, or
 * the context outline — is one solid block of what was said, and what you can
 * *do* with it hangs below, off the reading line and on the page rather than on
 * the block's own fill. Inside, the row had to borrow that fill and sat within
 * the same rounded edge as the content, so it read as part of what was said.
 *
 * Revealed on hover over the whole row (and on keyboard focus), so a trace
 * scrolled past is nothing but conversation.
 */
function TurnControls({
  text,
  diffSource,
  align,
  format = 'markdown',
  viewModes,
  spacing,
}: {
  text: string;
  diffSource: GitDiffSourceIdentity;
  /** Matches the block's own side, so the row stays under its own turn. */
  align: 'start' | 'end';
  /**
   * What a diff takes this text as. Chat turns render as markdown and cannot be
   * switched (see `SHOW_CHAT_VIEW_MODES`); a context block can be an outline,
   * so it passes whichever view is on screen.
   */
  format?: GitDiffFormat;
  /** Only the blocks with two rendered views offer a toggle, and only when on. */
  viewModes?: ContentToolbarProps['viewModes'];
  /** Message rows transfer their final 8px inset here; Context keeps its own row padding. */
  spacing: 'message' | 'context';
}) {
  return (
    <div
      className={cx(
        spacing === 'message' ? 'py-2' : 'mt-0.5',
        'opacity-0 transition-opacity group-hover/turn:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100',
      )}
    >
      <ContentToolbar
        variant="inline"
        text={text}
        diff={{ source: diffSource, format }}
        viewModes={viewModes}
        align={align}
      />
    </div>
  );
}

/**
 * The model behind a turn, dimmed and italic when it was borrowed.
 *
 * A turn rebuilt from a later request's history has no response of its own to
 * name a model, so it carries that request's — real captured data, but a
 * different turn's (see `modelFromRequest`). Rendering both the same way would
 * present an inference as an observation, which is the one thing a capture tool
 * must not do.
 */
function ModelName({ node }: { node: TraceNode }) {
  if (!node.model) return null;
  return (
    <span
      title={
        node.modelFromRequest
          ? 'From the request that replayed this turn — the response was not captured'
          : undefined
      }
      className={cx(
        'font-mono text-[12px]',
        node.modelFromRequest ? 'text-muted-soft italic' : 'text-muted-foreground',
      )}
    >
      {node.model}
    </span>
  );
}

/**
 * The bubble a turn is spoken in. Shared so a failed turn is the same shape as
 * the answer it was going to be — only the text colour differs.
 */
const TURN_BUBBLE = 'mt-1.5 rounded-2xl rounded-tl-sm border border-hairline bg-canvas px-4 py-3';

/** The assistant's own mark and screen-reader name, on both good turns and bad. */
function AssistantMark() {
  // Prefer the captured agent when available; unknown transport rows fall back
  // to the sole supported runtime, Claude Code.
  const { agent } = useAgent();
  const captured = agentForProvider(useContext(ConversationProvider));
  return (
    <>
      <BrandMark svg={(captured ?? agent).mark} size={28} />
      {/* The role, not the vendor: what a screen reader needs here is whose
          turn this is. */}
      <span className="sr-only">Assistant</span>
    </>
  );
}

/**
 * A failed turn, drawn as the assistant turn it was about to be.
 *
 * The error is the model's answer for that turn — the request was made, the
 * turn happened, and this is what came back. Rendering it as a bare red line
 * broke the column: the reply that failed sat in a different shape from every
 * reply that worked, so scanning the trace you lost the thread of who was
 * speaking. Same mark, same model name, same bubble — the red text is the only
 * thing that marks it as a failure, and it is enough. A badge saying `error`
 * over a paragraph that already reads `rate_limit_error: …` in red was the
 * label repeating what the content had said first.
 */
function ErrorNode({ node }: { node: TraceNode }) {
  return (
    <div className="group/turn">
      <Gutter label={<AssistantMark />} role="assistant" mark>
        <ModelName node={node} />
      </Gutter>
      <div
        className={cx(
          TURN_BUBBLE,
          'text-[13.5px] leading-[1.55] whitespace-pre-wrap text-error-fg',
        )}
      >
        {node.text}
      </div>
    </div>
  );
}

function AssistantNode({ node }: { node: TraceNode }) {
  const text = node.text ?? '';
  return (
    <div className="group/turn">
      <Gutter label={<AssistantMark />} role="assistant" mark>
        <ModelName node={node} />
        {/* No duration here. `node.durationMs` is one content block's streaming
            window — it starts at that block's first frame, so it excludes the
            wait before the first token and splits a multi-block response into
            several unrelated numbers. It read as "how long this turn took",
            which is not what it measures. The turn's real latency is on the
            exchange itself: Inspector → Timing, or the Network view. */}
        {node.usage?.outputTokens !== undefined && (
          <span className="font-mono text-[12px] text-muted-soft" title="output tokens">
            ↓{formatTokens(node.usage.outputTokens)}
          </span>
        )}
      </Gutter>
      <ContentViewer
        className={TURN_BUBBLE}
        variant="bare"
        text={text}
        formats={PROSE_FORMATS}
        maxHeightClass="max-h-none"
        proseClassName="markdown-chat"
        showViewModes={SHOW_CHAT_VIEW_MODES}
        controlsPlacement="external"
      />
      {/* Nothing to copy or diff until the response has said something — during
          a stream that is the first frame or two. */}
      {text && (
        <TurnControls
          text={text}
          diffSource={{
            sourceId: node.id,
            sessionId: node.conversationId,
            label: 'assistant message',
          }}
          // The assistant sits on the left, so its controls mirror the user's.
          align="start"
          spacing="message"
        />
      )}
    </div>
  );
}

function ThinkingNode({ node }: { node: TraceNode }) {
  const [open, setOpen] = useState(false);
  const text = node.text ?? '';
  return (
    <div>
      <Gutter label="thinking" role="thinking">
        {node.durationMs !== undefined && (
          <span className="font-mono text-[12px] text-muted-soft">{formatMs(node.durationMs)}</span>
        )}
      </Gutter>
      <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1.5 block w-full text-left">
        <div className="border-l-2 border-hairline pl-3 text-[13.5px] leading-[1.55] whitespace-pre-wrap text-muted-foreground italic">
          {open ? text : truncate(text.replace(/\s+/g, ' '), 160)}
        </div>
      </button>
    </div>
  );
}

function ContextNode({
  text,
  label,
  sourceId,
  sessionId,
  role = 'context',
  preferMarkdown = false,
  selected = false,
  onInspect,
}: {
  text: string;
  label: string;
  sourceId: string;
  sessionId: string;
  role?: RoleTone;
  /** System prompts are prose first; tag blocks are structure first. */
  preferMarkdown?: boolean;
  /** The source button stays visibly active while its Inspector target is open. */
  selected?: boolean;
  /** Opens the exact transport field this block was reconstructed from. */
  onInspect?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // `hasXmlStructure` parses the whole block, so it must not run per render.
  const formats = useMemo<ContentFormat[]>(
    () =>
      preferMarkdown ? (hasXmlStructure(text) ? ['markdown', 'xml'] : ['markdown']) : ['xml'],
    [text, preferMarkdown],
  );
  // The block's controls live outside its card (see `TurnControls`), so the
  // view state they act on is read here rather than inside the panel.
  const { modes, active, setMode } = useContentViewMode(formats, SHOW_CHAT_VIEW_MODES);
  return (
    <div className="group/turn flex w-full flex-col">
      {/*
        The pill has two explicit targets: its title discloses the rendered
        content, while the trailing source button opens this exact block in the
        Inspector. Keeping the content hidden until expansion prevents context
        and system blocks from reading like a second user-message bubble in the
        trace.
      */}
      <TagLabel
        role={role}
        flush
        size="control"
        className="self-end w-50 overflow-hidden"
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-full pl-3 outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current/40 dark:hover:bg-white/8"
        >
          <Chevron open={open} />
          <span className="min-w-0 flex-1 truncate text-center">{label}</span>
        </button>
        {onInspect && (
          <button
            type="button"
            onClick={onInspect}
            aria-pressed={selected}
            aria-label={`Open ${label} source in Inspector`}
            title={`Open ${label} source in Inspector`}
            className={cx(
              'flex size-7 shrink-0 items-center justify-center rounded-r-full border-l border-current/15 outline-none focus-visible:ring-2 focus-visible:ring-current/40',
              selected
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-black/5 dark:hover:bg-white/8',
            )}
          >
            <ExternalLink size={12} strokeWidth={2} aria-hidden />
          </button>
        )}
      </TagLabel>
      {/* Expanded, a context block is structure: show the tag outline, with the
          exact source a click away. */}
      {open && (
        <>
          <ContentViewer
            className="mt-1.5"
            text={text}
            formats={formats}
            maxHeightClass="max-h-[50vh]"
            showViewModes={SHOW_CHAT_VIEW_MODES}
            controlsPlacement="external"
            diffSource={{ sourceId, sessionId, label }}
          />
          {/* Under the card, not in it — the same rule the bubbles follow. The
              row keeps the bottom edge it had, but on the page instead of
              inside the panel's border. */}
          <TurnControls
            text={text}
            diffSource={{ sourceId, sessionId, label }}
            align="end"
            spacing="context"
            format={diffFormatFor(active, formats)}
            viewModes={
              SHOW_CHAT_VIEW_MODES ? { options: modes, active, onSelect: setMode } : undefined
            }
          />
        </>
      )}
    </div>
  );
}

/**
 * A notice about the trace itself rather than a turn in it — today only the
 * history-rewind marker. Errors used to share this shape; they are assistant
 * turns now (see `ErrorNode`), which leaves this with one caller and one tone.
 */
function BannerNode({ node, label }: { node: TraceNode; label: string }) {
  return (
    <div>
      <Gutter label={label} role="system" />
      <div className="mt-1.5 text-[13.5px] text-warning-fg">{node.text}</div>
    </div>
  );
}

function Gutter({
  label,
  role,
  align = 'start',
  iconOnly = false,
  mark = false,
  children,
}: {
  label: React.ReactNode;
  role: RoleTone;
  align?: 'start' | 'end';
  iconOnly?: boolean;
  /**
   * The label is a brand mark, not a role badge: no fill behind it, and the
   * accent instead of a role colour.
   *
   * A vendor logo already carries its own identity, so the chip under it was
   * saying "assistant" a second time in a different alphabet. Dropping the fill
   * leaves the mark alone against the canvas, and `primary` is the app's one
   * emphasis colour — the same one the inspect handle and selection use.
   */
  mark?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={cx('flex items-center gap-2.5', align === 'end' && 'justify-end')}>
      {mark ? (
        <span className="relative inline-flex size-8 shrink-0 items-center justify-center text-primary">
          {label}
        </span>
      ) : (
        <TagLabel role={role} iconOnly={iconOnly}>{label}</TagLabel>
      )}
      {children}
    </div>
  );
}
