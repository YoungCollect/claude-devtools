import { ExternalLink } from 'lucide-react';

import type { TraceNode } from '../../core/types.js';
import { toolResultText, truncate } from '../format.js';
import { cx, StatusBadge, TagLabel } from './ui.js';

/** A tool output shown in the request that sent it back to the model. */
export function ToolResultInputRow({
  node,
  selected,
  onInspect,
}: {
  node: TraceNode;
  selected: boolean;
  onInspect: (node: TraceNode) => void;
}) {
  const summary = truncate(toolResultText(node.toolResult).replace(/\s+/g, ' ').trim(), 120);
  const name = node.toolName ?? node.toolUseId ?? 'tool';
  return (
    <div
      data-trace-row=""
      data-trace-kind="message"
      className="flex w-full justify-end border-r-2 border-transparent px-4 py-3"
    >
      <div
        data-tool-result-input=""
        className={cx(
          'flex max-w-[72%] min-w-0 items-center gap-2.5 rounded-lg border bg-canvas py-2 pr-0 pl-3 text-left transition-colors',
          selected ? 'border-primary' : 'border-hairline',
        )}
      >
        <TagLabel role="tool">tool result</TagLabel>
        <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-soft">
          {summary || '(empty)'}
        </span>
        <StatusBadge tone={node.isError ? 'error' : 'success'}>
          {node.isError ? 'failed' : 'returned'}
        </StatusBadge>
        <button
          type="button"
          onClick={() => onInspect(node)}
          aria-label={`Inspect tool result from ${name}`}
          title="Inspect tool result in request payload"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-primary outline-none hover:bg-surface-soft focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <ExternalLink size={13} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}
