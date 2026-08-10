import { useState } from 'react';
import type { TraceNode } from '../../core/types.js';
import { formatMs, formatTokens, summarizeToolInput, toolResultText, truncate } from '../format.js';
import { Badge, Chevron, cx, Empty } from './ui.js';

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
    <div className="flex flex-col">
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
  return (
    <div
      onClick={() => onInspect(node)}
      className={cx(
        'group relative cursor-pointer border-l-2 py-1.5 pr-3 pl-3 transition-colors',
        selected
          ? 'border-accent bg-accent/[0.07]'
          : 'border-transparent hover:border-ink-700 hover:bg-ink-900/60',
      )}
    >
      <NodeBody node={node} />
      <span className="pointer-events-none absolute top-1.5 right-3 hidden font-mono text-[10px] text-ink-400 group-hover:block">
        inspect →
      </span>
    </div>
  );
}

function NodeBody({ node }: { node: TraceNode }) {
  switch (node.kind) {
    case 'user':
      return <UserNode node={node} />;
    case 'assistant':
      return <AssistantNode node={node} />;
    case 'thinking':
      return <CollapsibleText node={node} label="thinking" tone="neutral" />;
    case 'tool_call':
      return <ToolCallNode node={node} />;
    case 'tool_result':
      return <ToolResultNode node={node} />;
    case 'compaction':
      return <BannerNode node={node} tone="warn" label="context" />;
    case 'error':
      return <BannerNode node={node} tone="danger" label="error" />;
    default:
      return <CollapsibleText node={node} label={node.kind} tone="neutral" />;
  }
}

function UserNode({ node }: { node: TraceNode }) {
  const raw = node.text ?? '';
  const { text, reminders } = splitSystemReminders(raw);

  // Claude Code injects `<system-reminder>` blocks as their own content blocks
  // inside the user message. Rendering each as a full user turn buries the
  // sentence the human actually typed, so a reminder-only block collapses to a
  // dim one-liner — still on the trace, still inspectable, just not shouting.
  if (!text && reminders > 0) return <ContextNode text={raw} label="system-reminder" />;

  return (
    <div>
      <Gutter label="user" tone="accent" />
      <div className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-100">
        {text || <span className="text-ink-400 italic">(no visible text)</span>}
      </div>
      {reminders > 0 && (
        <div className="mt-1 font-mono text-[10px] text-ink-400">
          + {reminders} system-reminder block{reminders > 1 ? 's' : ''} (hidden — see Payload)
        </div>
      )}
    </div>
  );
}

function ContextNode({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-baseline gap-2">
      <Badge>{label}</Badge>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
        }}
        className="min-w-0 flex-1 text-left"
      >
        <div
          className={cx(
            'font-mono text-[10.5px] text-ink-400',
            open ? 'whitespace-pre-wrap' : 'truncate',
          )}
        >
          {open ? text : text.replace(/\s+/g, ' ').trim()}
        </div>
      </button>
    </div>
  );
}

function AssistantNode({ node }: { node: TraceNode }) {
  return (
    <div>
      <Gutter label="assistant" tone="ok">
        {node.model && <Badge>{node.model}</Badge>}
        {node.durationMs !== undefined && <Badge>{formatMs(node.durationMs)}</Badge>}
        {node.usage?.outputTokens !== undefined && (
          <Badge title="output tokens">↓{formatTokens(node.usage.outputTokens)}</Badge>
        )}
      </Gutter>
      <div className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-100">
        {node.text}
      </div>
    </div>
  );
}

function ToolCallNode({ node }: { node: TraceNode }) {
  return (
    <div>
      <Gutter label="tool call" tone="tool">
        <span className="font-mono text-[11.5px] text-tool">{node.toolName}</span>
        {node.durationMs !== undefined && (
          <Badge title="model time to emit this call">{formatMs(node.durationMs)}</Badge>
        )}
      </Gutter>
      <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-300">
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
      <Gutter label="tool result" tone={node.isError ? 'danger' : 'neutral'}>
        {node.toolName && <span className="font-mono text-[11.5px] text-ink-300">{node.toolName}</span>}
        {node.isError && <Badge tone="danger">error</Badge>}
        {node.durationMs !== undefined && (
          <Badge
            tone="warn"
            title={
              node.durationIsBatch
                ? 'Wall time for the whole parallel tool batch — the agent ran several calls in this window'
                : 'Time between the end of the model response and the request carrying this result'
            }
          >
            tool {formatMs(node.durationMs)}
            {node.durationIsBatch ? ' ·batch' : ''}
          </Badge>
        )}
      </Gutter>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
        }}
        className="mt-0.5 block w-full text-left"
      >
        <pre
          className={cx(
            'overflow-hidden font-mono text-[11px] leading-[1.5] whitespace-pre-wrap',
            node.isError ? 'text-danger/90' : 'text-ink-400',
          )}
        >
          {open ? text : collapsed || '(empty)'}
        </pre>
        {lines.length > 3 && (
          <span className="mt-0.5 inline-flex items-center gap-1 font-mono text-[10px] text-ink-400 hover:text-ink-300">
            <Chevron open={open} />
            {open ? 'collapse' : `${lines.length - 3} more lines`}
          </span>
        )}
      </button>
    </div>
  );
}

function CollapsibleText({
  node,
  label,
  tone,
}: {
  node: TraceNode;
  label: string;
  tone: 'neutral';
}) {
  const [open, setOpen] = useState(false);
  const text = node.text ?? '';
  return (
    <div>
      <Gutter label={label} tone={tone}>
        {node.durationMs !== undefined && <Badge>{formatMs(node.durationMs)}</Badge>}
      </Gutter>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
        }}
        className="mt-0.5 block w-full text-left"
      >
        <div className="font-mono text-[11px] leading-[1.5] whitespace-pre-wrap text-ink-400 italic">
          {open ? text : truncate(text.replace(/\s+/g, ' '), 140)}
        </div>
      </button>
    </div>
  );
}

function BannerNode({ node, tone, label }: { node: TraceNode; tone: 'warn' | 'danger'; label: string }) {
  return (
    <div>
      <Gutter label={label} tone={tone} />
      <div
        className={cx(
          'mt-0.5 font-mono text-[11.5px]',
          tone === 'danger' ? 'text-danger' : 'text-warn',
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
  children,
}: {
  label: string;
  tone: 'accent' | 'ok' | 'tool' | 'warn' | 'danger' | 'neutral';
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Badge tone={tone}>{label}</Badge>
      {children}
    </div>
  );
}

/**
 * Claude Code injects `<system-reminder>` blocks into user turns. They are real
 * payload but they are not what the human said, so the trace counts them and
 * leaves the full text to the Payload tab.
 */
function splitSystemReminders(raw: string): { text: string; reminders: number } {
  const matches = raw.match(/<system-reminder>[\s\S]*?<\/system-reminder>/g);
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return { text, reminders: matches?.length ?? 0 };
}
