import { useMemo, useState } from 'react';
import { splitTaggedUserContent } from '../../core/tagged-content.js';
import { hasXmlStructure } from '../../core/xml-outline.js';
import { ContentViewer, type ContentFormat } from './ContentViewer.js';
import type { TraceNode } from '../../core/types.js';
import { groupTrace, turnNodes, type ToolActivity, type TraceTurn } from '../trace-groups.js';
import { formatMs, formatTokens, pretty, toolResultText, truncate } from '../format.js';
import { Badge, Chevron, cx, Empty, TagLabel, type Tone } from './ui.js';

/**
 * Chat turns are prose. Module-level so every bubble shares one array — the
 * viewer memoises its mode list on this identity, and a literal rebuilt per
 * render would defeat that on every streamed frame.
 */
const PROSE_FORMATS: ContentFormat[] = ['markdown'];

export interface TraceViewProps {
  nodes: TraceNode[];
  selectedNodeId?: string;
  onInspect: (node: TraceNode) => void;
}

/**
 * The Chat Trace: the agent's run as a developer reads it, in the order it
 * happened. Every row is a drill-down handle — that link from "what the agent
 * did" to "what went over the wire" is the whole point of the tool.
 */
export function TraceView({ nodes, selectedNodeId, onInspect }: TraceViewProps) {
  // `groupTrace` walks the whole list, so it must not re-run per render — the
  // store bumps its revision on every streamed frame.
  const items = useMemo(() => groupTrace(nodes), [nodes]);
  if (items.length === 0) {
    return <Empty>No trace events yet. Point an agent at the proxy and send a message.</Empty>;
  }
  return (
    <div className="flex flex-col divide-y divide-hairline-soft">
      {items.map((item) =>
        item.type === 'turn' ? (
          <TurnRow
            key={item.key}
            turn={item}
            selectedNodeId={selectedNodeId}
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
function TurnRow({
  turn,
  selectedNodeId,
  onInspect,
}: {
  turn: TraceTurn;
  selectedNodeId?: string;
  onInspect: (node: TraceNode) => void;
}) {
  const members = turnNodes(turn);
  const selected = selectedNodeId !== undefined && members.some(({ id }) => id === selectedNodeId);
  // The row-level handle drills into the response that produced the turn.
  // Each tool activity carries its own, because a result arrives on a *later*
  // request and that request would otherwise have no handle in the trace.
  const primary = members[0];

  return (
    <div
      className={cx(
        'group relative flex w-full justify-start border-l-2 px-4 py-4 transition-colors',
        selected ? 'border-primary bg-surface-soft' : 'border-transparent hover:bg-surface-soft/60',
      )}
    >
      <div className="min-w-0 flex-1">
        {turn.messages.map((node) => (
          <AssistantNode key={node.id} node={node} />
        ))}
        {turn.tools.length > 0 && (
          <div className={turn.messages.length > 0 ? 'mt-3' : undefined}>
            <ToolStrip activities={turn.tools} onInspect={onInspect} />
          </div>
        )}
      </div>
      {primary && (
        <button
          type="button"
          onClick={() => onInspect(primary)}
          title="Inspect the HTTP exchange behind this turn"
          className={cx(
            'absolute top-3 right-4 text-[12px] font-medium text-primary opacity-0 transition-opacity',
            'group-hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          inspect →
        </button>
      )}
    </div>
  );
}

/**
 * The turn's tool round, one line until asked.
 *
 * Collapsed it names what ran; opened it shows each call's full input and full
 * result. The full input is new here — the old single-node row only ever showed
 * `summarizeToolInput`'s one-line gist, so the actual arguments were reachable
 * only through the Inspector.
 */
function ToolStrip({
  activities,
  onInspect,
}: {
  activities: ToolActivity[];
  onInspect: (node: TraceNode) => void;
}) {
  const [open, setOpen] = useState(false);
  const names = [...new Set(activities.map((a) => a.call?.toolName ?? a.result?.toolName ?? 'tool'))];
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
        <Chevron open={open} />
        <TagLabel tone="tool">
          {activities.length === 1 ? '1 tool' : `${activities.length} tools`}
        </TagLabel>
        <span className="min-w-0 truncate font-mono text-[12.5px] text-muted-foreground">
          {names.join(' · ')}
        </span>
        {failed > 0 && <Badge tone="error">{failed} failed</Badge>}
        {pending > 0 && <Badge tone="warning">{pending} pending</Badge>}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {activities.map((activity) => (
            <ToolActivityCard key={activity.id} activity={activity} onInspect={onInspect} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolActivityCard({
  activity,
  onInspect,
}: {
  activity: ToolActivity;
  onInspect: (node: TraceNode) => void;
}) {
  const { call, result } = activity;
  const name = call?.toolName ?? result?.toolName ?? 'tool';
  // The result arrived on a different request than the call; that later request
  // is the more useful drill-down, so it wins when both exist.
  const target = result ?? call;

  return (
    <div className="rounded-lg border border-hairline">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span className="text-[14px] font-medium text-ink">{name}</span>
        {call?.durationMs !== undefined && (
          <span className="font-mono text-[12px] text-muted-soft" title="model time to emit this call">
            {formatMs(call.durationMs)}
          </span>
        )}
        {result?.isError && <Badge tone="error">error</Badge>}
        {result?.durationMs !== undefined && (
          <Badge
            tone="warning"
            title={
              result.durationIsBatch
                ? 'Wall time for the whole parallel tool batch — the agent ran several calls in this window'
                : 'Time between the end of the model response and the request carrying this result'
            }
          >
            tool {formatMs(result.durationMs)}
            {result.durationIsBatch ? ' · batch' : ''}
          </Badge>
        )}
        {target && (
          <button
            type="button"
            onClick={() => onInspect(target)}
            title="Inspect the HTTP exchange behind this tool call"
            className="ml-auto shrink-0 text-[12px] font-medium text-primary"
          >
            inspect →
          </button>
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

/** Tool input and tool output are both machine text: dark surface, capped height. */
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
      <div className="max-h-[260px] overflow-auto rounded-md border border-code-border bg-code">
        <pre
          className={cx(
            'px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] whitespace-pre-wrap',
            isError ? 'text-code-error' : 'text-code-fg-soft',
          )}
        >
          {text.trim() || empty}
        </pre>
      </div>
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
  const rightAligned =
    node.kind === 'system' || node.kind === 'context' || node.kind === 'user';
  // System and context blocks hold rendered markdown and tag outlines. Those are
  // documents, not chat turns: constraining them to a bubble width reflows code
  // and tables for no reason, so they take the full column.
  const contentWidth =
    node.kind === 'user' || node.kind === 'assistant' ? 'max-w-[72%]' : 'w-full';
  return (
    <div
      // Equal padding on both sides, not just the gutter one. The inspect button
      // is absolutely positioned, so only one edge strictly needs the room — but
      // a full-width block inset further on one side than the other reads as
      // misaligned, and the trace is scanned down its edges.
      className={cx(
        'group relative flex w-full px-4 py-4 transition-colors',
        rightAligned ? 'justify-end border-r-2' : 'justify-start border-l-2',
        selected ? 'border-primary bg-surface-soft' : 'border-transparent hover:bg-surface-soft/60',
      )}
    >
      <div className={cx('min-w-0', contentWidth)}>
        <NodeBody node={node} />
      </div>
      {/*
        Inspecting is its own button, not a click anywhere on the row. Rows carry
        their own controls — expanding a context block, folding a tag, selecting
        text out of a payload — and a row-wide handler made every one of those a
        near miss that threw the side panel open.
      */}
      <button
        type="button"
        onClick={() => onInspect(node)}
        title="Inspect the HTTP exchange behind this event"
        className={cx(
          // Revealed on hover so a scanned list stays quiet. Kept in the DOM
          // rather than swapped with `hidden`, so it is still reachable by
          // keyboard — focus brings it back on its own.
          'absolute top-3 text-[12px] font-medium text-primary opacity-0 transition-opacity',
          'group-hover:opacity-100 focus-visible:opacity-100',
          rightAligned ? 'left-4' : 'right-4',
        )}
      >
        inspect →
      </button>
    </div>
  );
}

function NodeBody({ node }: { node: TraceNode }) {
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
          tone="warning"
          preferMarkdown
        />
      );
    case 'context':
      return (
        <ContextNode
          text={node.text ?? ''}
          label={node.contextTag ?? 'context'}
          sourceId={node.id}
          sessionId={node.conversationId}
          tone="neutral"
        />
      );
    case 'user':
      return <UserNode node={node} />;
    case 'assistant':
      return <AssistantNode node={node} />;
    case 'thinking':
      return <ThinkingNode node={node} />;
    case 'compaction':
      return <BannerNode node={node} tone="warning" label="context" />;
    case 'error':
      return <BannerNode node={node} tone="error" label="error" />;
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
    <div>
      <Gutter label="user" tone="emph" align="end" />
      <div className="mt-1.5 rounded-2xl rounded-tr-sm bg-surface-card px-4 py-3">
        {text ? (
          <ContentViewer
            variant="bare"
            text={text}
            formats={PROSE_FORMATS}
            maxHeightClass="max-h-none"
            proseClassName="markdown-chat markdown-lead"
            diffSource={{ sourceId, sessionId, label: 'user message' }}
          />
        ) : (
          <span className="display text-[17px] text-muted-soft italic">(no visible text)</span>
        )}
      </div>
    </div>
  );
}

function AssistantNode({ node }: { node: TraceNode }) {
  const text = node.text ?? '';
  return (
    <div>
      <Gutter label="assistant" tone="success">
        {node.model && <span className="font-mono text-[12px] text-muted-foreground">{node.model}</span>}
        {node.durationMs !== undefined && (
          <span className="font-mono text-[12px] text-muted-soft">{formatMs(node.durationMs)}</span>
        )}
        {node.usage?.outputTokens !== undefined && (
          <span className="font-mono text-[12px] text-muted-soft" title="output tokens">
            ↓{formatTokens(node.usage.outputTokens)}
          </span>
        )}
      </Gutter>
      <div className="mt-1.5 rounded-2xl rounded-tl-sm border border-hairline bg-surface-soft px-4 py-3">
        <ContentViewer
          variant="bare"
          text={text}
          formats={PROSE_FORMATS}
          maxHeightClass="max-h-none"
          proseClassName="markdown-chat"
          // The assistant sits on the left, so its controls mirror the user's.
          controlsAlign="start"
          diffSource={{ sourceId: node.id, sessionId: node.conversationId, label: 'assistant message' }}
        />
      </div>
    </div>
  );
}

function ThinkingNode({ node }: { node: TraceNode }) {
  const [open, setOpen] = useState(false);
  const text = node.text ?? '';
  return (
    <div>
      <Gutter label="thinking" tone="neutral">
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
  tone = 'neutral',
  preferMarkdown = false,
}: {
  text: string;
  label: string;
  sourceId: string;
  sessionId: string;
  tone?: Tone;
  /** System prompts are prose first; tag blocks are structure first. */
  preferMarkdown?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // `hasXmlStructure` parses the whole block, so it must not run per render.
  const formats = useMemo<ContentFormat[]>(
    () =>
      preferMarkdown ? (hasXmlStructure(text) ? ['markdown', 'xml'] : ['markdown']) : ['xml'],
    [text, preferMarkdown],
  );
  return (
    <div className="flex w-full flex-col">
      {/*
        The title is the only control, in both states. Wrapping the collapsed
        preview in the button too made the target change shape as you used it —
        click anywhere to open, then only the header to close — and once open it
        would have fought the mode toggles and text selection inside the body.
      */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 self-end"
      >
        <Chevron open={open} />
        <TagLabel tone={tone}>{label}</TagLabel>
      </button>
      {!open && (
        <div className="mt-1.5 truncate rounded-xl border border-hairline bg-surface-soft px-3 py-2.5 text-right text-[12.5px] text-muted-soft">
          {text.replace(/\s+/g, ' ').trim()}
        </div>
      )}
      {/* Expanded, a context block is structure: show the tag outline, with the
          exact source a click away. */}
      {open && (
        <ContentViewer
          className="mt-1.5"
          text={text}
          formats={formats}
          maxHeightClass="max-h-[50vh]"
          diffSource={{ sourceId, sessionId, label }}
        />
      )}
    </div>
  );
}

function BannerNode({
  node,
  tone,
  label,
}: {
  node: TraceNode;
  tone: 'warning' | 'error';
  label: string;
}) {
  return (
    <div>
      <Gutter label={label} tone={tone} />
      <div
        className={cx(
          'mt-1.5 text-[13.5px]',
          tone === 'error' ? 'text-error-fg' : 'text-warning-fg',
        )}
      >
        {node.text}
      </div>
    </div>
  );
}

function Gutter({
  label,
  tone,
  align = 'start',
  children,
}: {
  label: string;
  tone: Tone;
  align?: 'start' | 'end';
  children?: React.ReactNode;
}) {
  return (
    <div className={cx('flex items-center gap-2.5', align === 'end' && 'justify-end')}>
      <TagLabel tone={tone}>{label}</TagLabel>
      {children}
    </div>
  );
}
