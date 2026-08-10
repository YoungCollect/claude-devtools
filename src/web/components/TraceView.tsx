import { useState } from 'react';
import { splitTaggedUserContent } from '../../core/tagged-content.js';
import type { TraceNode } from '../../core/types.js';
import { formatMs, formatTokens, summarizeToolInput, toolResultText, truncate } from '../format.js';
import { Badge, Chevron, cx, Empty, TagLabel, type Tone } from './ui.js';

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
  const visible = nodes.filter((node) => node.kind !== 'assistant' || (node.text ?? '').trim());
  if (visible.length === 0) {
    return <Empty>No trace events yet. Point an agent at the proxy and send a message.</Empty>;
  }
  return (
    <div className="flex flex-col divide-y divide-hairline-soft">
      {visible.map((node) => (
        <TraceRow
          key={node.id}
          node={node}
          selected={node.id === selectedNodeId}
          onInspect={onInspect}
        />
      ))}
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
  const contentWidth =
    node.kind === 'system' || node.kind === 'context'
      ? 'w-[82%]'
      : node.kind === 'user' || node.kind === 'assistant'
        ? 'max-w-[72%]'
        : 'w-full';
  return (
    <div
      onClick={() => onInspect(node)}
      className={cx(
        'group relative flex w-full cursor-pointer py-4 transition-colors',
        rightAligned
          ? 'justify-end border-r-2 pr-4 pl-10'
          : 'justify-start border-l-2 pr-10 pl-4',
        selected ? 'border-primary bg-surface-soft' : 'border-transparent hover:bg-surface-soft/60',
      )}
    >
      <div className={cx('min-w-0', contentWidth)}>
        <NodeBody node={node} />
      </div>
      <span
        className={cx(
          'pointer-events-none absolute top-3 hidden text-[12px] font-medium text-primary group-hover:block',
          rightAligned ? 'left-4' : 'right-4',
        )}
      >
        inspect →
      </span>
    </div>
  );
}

function NodeBody({ node }: { node: TraceNode }) {
  switch (node.kind) {
    case 'system':
      return (
        <ContextNode
          text={node.text ?? ''}
          label={node.systemSource === 'prompt' ? 'system prompt' : 'system'}
          tone="warning"
        />
      );
    case 'context':
      return (
        <ContextNode text={node.text ?? ''} label={node.contextTag ?? 'context'} tone="neutral" />
      );
    case 'user':
      return <UserNode node={node} />;
    case 'assistant':
      return <AssistantNode node={node} />;
    case 'thinking':
      return <ThinkingNode node={node} />;
    case 'tool_call':
      return <ToolCallNode node={node} />;
    case 'tool_result':
      return <ToolResultNode node={node} />;
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
            />
          ) : (
            <UserBubble key={`user-${index}`} text={segment.text} />
          ),
        )}
      </div>
    );
  }

  return <UserBubble text={segments[0]?.text ?? raw} />;
}

function UserBubble({ text }: { text: string }) {
  return (
    <div>
      <Gutter label="user" tone="emph" align="end" />
      <div className="display mt-1.5 rounded-2xl rounded-tr-sm bg-surface-card px-4 py-3 text-[17px] leading-[1.4] whitespace-pre-wrap text-ink">
        {text || <span className="text-muted-soft italic">(no visible text)</span>}
      </div>
    </div>
  );
}

function AssistantNode({ node }: { node: TraceNode }) {
  return (
    <div>
      <Gutter label="assistant" tone="success">
        {node.model && <span className="font-mono text-[12px] text-muted">{node.model}</span>}
        {node.durationMs !== undefined && (
          <span className="font-mono text-[12px] text-muted-soft">{formatMs(node.durationMs)}</span>
        )}
        {node.usage?.outputTokens !== undefined && (
          <span className="font-mono text-[12px] text-muted-soft" title="output tokens">
            ↓{formatTokens(node.usage.outputTokens)}
          </span>
        )}
      </Gutter>
      <div className="mt-1.5 rounded-2xl rounded-tl-sm border border-hairline bg-surface-soft px-4 py-3 text-[14px] leading-[1.55] whitespace-pre-wrap text-body-strong">
        {node.text}
      </div>
    </div>
  );
}

function ToolCallNode({ node }: { node: TraceNode }) {
  return (
    <div>
      <Gutter label="tool call" tone="tool">
        <span className="text-[14px] font-medium text-ink">{node.toolName}</span>
        {node.durationMs !== undefined && (
          <span
            className="font-mono text-[12px] text-muted-soft"
            title="model time to emit this call"
          >
            {formatMs(node.durationMs)}
          </span>
        )}
      </Gutter>
      {/* Shrink-to-fit: a full-width bar for `ls -la` reads as a code block it
          isn't, and the trace loses its scannable left edge. */}
      <div className="mt-1.5 inline-block max-w-full truncate rounded-md bg-surface-card px-2.5 py-1.5 align-top font-mono text-[12.5px] text-body">
        {summarizeToolInput(node.toolInput)}
      </div>
    </div>
  );
}

function ToolResultNode({ node }: { node: TraceNode }) {
  const [open, setOpen] = useState(false);
  const text = toolResultText(node.toolResult);
  const lines = text.split('\n');
  const collapsed = lines.slice(0, 3).join('\n');

  return (
    <div>
      <Gutter label="tool result" tone={node.isError ? 'error' : 'neutral'}>
        {node.toolName && <span className="text-[14px] text-body">{node.toolName}</span>}
        {node.isError && <Badge tone="error">error</Badge>}
        {node.durationMs !== undefined && (
          <Badge
            tone="warning"
            title={
              node.durationIsBatch
                ? 'Wall time for the whole parallel tool batch — the agent ran several calls in this window'
                : 'Time between the end of the model response and the request carrying this result'
            }
          >
            tool {formatMs(node.durationMs)}
            {node.durationIsBatch ? ' · batch' : ''}
          </Badge>
        )}
      </Gutter>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
        }}
        className="mt-1.5 block w-full text-left"
      >
        {/* Tool output is terminal output — it belongs on the dark surface. */}
        <div className="on-code overflow-hidden rounded-lg bg-code">
          <pre
            className={cx(
              'overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] whitespace-pre-wrap',
              node.isError ? 'text-code-error' : 'text-code-fg-soft',
            )}
          >
            {open ? text : collapsed || '(empty)'}
          </pre>
        </div>
        {lines.length > 3 && (
          <span className="mt-1 inline-flex items-center gap-1.5 text-[12px] font-medium text-muted hover:text-ink">
            <Chevron open={open} />
            {open ? 'collapse' : `${lines.length - 3} more lines`}
          </span>
        )}
      </button>
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
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
        }}
        className="mt-1.5 block w-full text-left"
      >
        <div className="border-l-2 border-hairline pl-3 text-[13.5px] leading-[1.55] whitespace-pre-wrap text-muted italic">
          {open ? text : truncate(text.replace(/\s+/g, ' '), 160)}
        </div>
      </button>
    </div>
  );
}

function ContextNode({
  text,
  label,
  tone = 'neutral',
}: {
  text: string;
  label: string;
  tone?: Tone;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
        }}
        className="block w-full text-left"
      >
        <span className="flex items-center justify-end gap-1.5">
          <Chevron open={open} />
          <TagLabel tone={tone}>{label}</TagLabel>
        </span>
        <div
          className={cx(
            'mt-1.5 rounded-xl border border-hairline bg-surface-soft px-3 py-2.5 text-[12.5px] text-muted-soft',
            open ? 'font-mono whitespace-pre-wrap' : 'truncate text-right',
          )}
        >
          {open ? text : text.replace(/\s+/g, ' ').trim()}
        </div>
      </button>
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
