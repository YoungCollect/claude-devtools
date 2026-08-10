import { useState } from 'react';
import type { TransportSummary } from '../../core/types.js';
import { formatBytes, formatClock, formatMs, formatTokens } from '../format.js';
import { Badge, Button, cx, Empty } from './ui.js';

export interface NetworkViewProps {
  transport: TransportSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

/**
 * The flat request list — the same traffic the Chat Trace summarises, including
 * the utility calls the trace hides. Selecting a row opens the same Inspector,
 * so the two views are two entrances to one dataset.
 */
export function NetworkView({ transport, selectedId, onSelect }: NetworkViewProps) {
  const [query, setQuery] = useState('');
  const [showUtility, setShowUtility] = useState(true);

  const rows = transport
    .filter((row) => showUtility || row.kind === 'conversation')
    .filter((row) =>
      query
        ? `${row.path} ${row.model ?? ''} ${row.status ?? ''} ${row.kind}`
            .toLowerCase()
            .includes(query.toLowerCase())
        : true,
    )
    .slice()
    .reverse();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-2.5">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter path, model, status…"
          className="h-9 w-64 rounded-md border border-hairline bg-canvas px-3.5 text-[14px] text-ink outline-none placeholder:text-muted-soft focus:border-primary focus:ring-3 focus:ring-primary/15"
        />
        <Button onClick={() => setShowUtility((v) => !v)} active={!showUtility}>
          {showUtility ? 'all requests' : 'conversation only'}
        </Button>
        <span className="ml-auto text-[13px] text-muted">{rows.length} requests</span>
      </div>

      <div className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <Empty>No requests captured yet.</Empty>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead className="sticky top-0 z-10 bg-surface-soft text-muted">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:text-[12px] [&>th]:font-medium [&>th]:tracking-[1.5px] [&>th]:uppercase">
                <th>time</th>
                <th>path</th>
                <th>status</th>
                <th>model</th>
                <th className="text-right">ttfb</th>
                <th className="text-right">total</th>
                <th className="text-right">size</th>
                <th className="text-right">tokens</th>
                <th>turn</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => onSelect(row.id)}
                  className={cx(
                    'cursor-pointer border-t border-hairline-soft [&>td]:px-3 [&>td]:py-2',
                    row.id === selectedId
                      ? 'bg-surface-card'
                      : 'hover:bg-surface-soft',
                    row.kind !== 'conversation' && 'text-muted-soft',
                  )}
                >
                  <td className="font-mono whitespace-nowrap text-muted">
                    {formatClock(row.startedAt)}
                  </td>
                  <td className="max-w-[240px] truncate">
                    <span className="font-mono text-body-strong">{row.path}</span>
                    {row.kind !== 'conversation' && (
                      <span className="ml-2 text-[12px] text-muted-soft">{row.kind}</span>
                    )}
                  </td>
                  <td>
                    {row.error ? (
                      <Badge tone="error">err</Badge>
                    ) : row.status === undefined ? (
                      <Badge tone="warning">…</Badge>
                    ) : (
                      <Badge tone={row.status >= 400 ? 'error' : 'success'}>{row.status}</Badge>
                    )}
                  </td>
                  <td className="max-w-[160px] truncate font-mono text-[12.5px]">
                    {row.model ?? '—'}
                  </td>
                  <td className="text-right font-mono text-[12.5px]">{formatMs(row.ttfbMs)}</td>
                  <td className="text-right font-mono text-[12.5px]">{formatMs(row.durationMs)}</td>
                  <td className="text-right font-mono text-[12.5px] text-muted">
                    {formatBytes(row.responseBytes)}
                  </td>
                  <td className="text-right font-mono text-[12.5px]">
                    {row.usage
                      ? `${formatTokens(row.usage.inputTokens)}/${formatTokens(row.usage.outputTokens)}`
                      : '—'}
                  </td>
                  <td className="font-mono text-[12.5px] text-muted">
                    {row.turnIndex !== undefined ? `#${row.turnIndex + 1}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
