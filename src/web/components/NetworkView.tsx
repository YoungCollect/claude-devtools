import { useState } from 'react';
import type { TransportSummary } from '../../core/types.js';
import { formatBytes, formatClock, formatMs, formatTokens } from '../format.js';
import { Badge, cx, Empty } from './ui.js';

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
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-1.5">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter path, model, status…"
          className="w-56 rounded border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-[11px] text-ink-100 outline-none placeholder:text-ink-400 focus:border-accent/50"
        />
        <button
          type="button"
          onClick={() => setShowUtility((v) => !v)}
          className={cx(
            'rounded border px-1.5 py-0.5 font-mono text-[10px]',
            showUtility
              ? 'border-ink-700 text-ink-400 hover:text-ink-100'
              : 'border-accent/40 bg-accent/10 text-accent',
          )}
        >
          {showUtility ? 'all requests' : 'conversation only'}
        </button>
        <span className="ml-auto font-mono text-[10px] text-ink-400">{rows.length} requests</span>
      </div>

      <div className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <Empty>No requests captured yet.</Empty>
        ) : (
          <table className="w-full border-collapse font-mono text-[11px]">
            <thead className="sticky top-0 z-10 bg-ink-900 text-ink-400">
              <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:text-left [&>th]:font-normal">
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
                    'cursor-pointer border-t border-ink-850 [&>td]:px-2 [&>td]:py-1',
                    row.id === selectedId ? 'bg-accent/[0.09]' : 'hover:bg-ink-900',
                    row.kind !== 'conversation' && 'text-ink-400',
                  )}
                >
                  <td className="whitespace-nowrap text-ink-400">{formatClock(row.startedAt)}</td>
                  <td className="max-w-[220px] truncate">
                    <span className="text-ink-100">{row.path}</span>
                    {row.kind !== 'conversation' && (
                      <span className="ml-1.5 text-[10px] text-ink-400">{row.kind}</span>
                    )}
                  </td>
                  <td>
                    {row.error ? (
                      <Badge tone="danger">err</Badge>
                    ) : row.status === undefined ? (
                      <Badge tone="warn">…</Badge>
                    ) : (
                      <Badge tone={row.status >= 400 ? 'danger' : 'ok'}>{row.status}</Badge>
                    )}
                  </td>
                  <td className="max-w-[140px] truncate">{row.model ?? '—'}</td>
                  <td className="text-right">{formatMs(row.ttfbMs)}</td>
                  <td className="text-right">{formatMs(row.durationMs)}</td>
                  <td className="text-right text-ink-400">{formatBytes(row.responseBytes)}</td>
                  <td className="text-right">
                    {row.usage
                      ? `${formatTokens(row.usage.inputTokens)}/${formatTokens(row.usage.outputTokens)}`
                      : '—'}
                  </td>
                  <td className="text-ink-400">
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
