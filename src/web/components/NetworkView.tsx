import { useState } from 'react';
import type { TransportSummary } from '../../core/types.js';
import { formatBytes, formatClock, formatMs, formatTokens } from '../format.js';
import { cx, Empty, StatusBadge } from './ui.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';

export interface NetworkViewProps {
  transport: TransportSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

/** Column heads are the system's uppercase category label, not shadcn's sentence-case default. */
const HEAD = 'px-3 py-2 text-[12px] font-medium tracking-[1.5px] text-muted-foreground uppercase';
const NUM = 'px-3 py-2 text-right font-mono text-[12.5px]';

/**
 * The selected conversation's request list. Selecting a row opens the same
 * Inspector, so Chat Trace and Network are two entrances to the same scoped
 * dataset.
 */
export function NetworkView({ transport, selectedId, onSelect }: NetworkViewProps) {
  const [query, setQuery] = useState('');

  const rows = transport
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
        <label htmlFor="network-filter" className="sr-only">
          Filter requests by path, model, or status
        </label>
        <input
          id="network-filter"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery('');
            }
          }}
          placeholder="Filter path, model, status…"
          className="h-9 w-64 rounded-md border border-hairline bg-canvas px-3.5 text-[14px] text-ink outline-none placeholder:text-muted-soft focus:border-primary focus:ring-3 focus:ring-primary/15"
        />
        <span role="status" aria-live="polite" className="ml-auto text-[13px] text-muted-foreground">
          {rows.length} requests
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="flex-1 overflow-auto">
          <Empty>No requests captured yet.</Empty>
        </div>
      ) : (
        <Table containerClassName="scroll-surface min-h-0 flex-1 overflow-auto" className="text-[13px]">
          <TableHeader className="sticky top-0 z-10 bg-surface-soft">
            <TableRow className="hover:bg-surface-soft">
              <TableHead className={HEAD}>time</TableHead>
              <TableHead className={HEAD}>path</TableHead>
              <TableHead className={HEAD}>status</TableHead>
              <TableHead className={HEAD}>model</TableHead>
              <TableHead className={cx(HEAD, 'text-right')}>ttfb</TableHead>
              <TableHead className={cx(HEAD, 'text-right')}>total</TableHead>
              <TableHead className={cx(HEAD, 'text-right')}>size</TableHead>
              <TableHead className={cx(HEAD, 'text-right')}>tokens</TableHead>
              <TableHead className={HEAD}>turn</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.id}
                tabIndex={0}
                role="button"
                aria-label={`Inspect ${row.method ?? row.kind} ${row.path}${
                  row.status !== undefined ? `, status ${row.status}` : ''
                }`}
                onClick={() => onSelect(row.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onSelect(row.id);
                }}
                // `data-state` is shadcn's own selected-row hook; the fill it
                // resolves to is this system's selected surface, not the default.
                data-state={row.id === selectedId ? 'selected' : undefined}
                className={cx(
                  'cursor-pointer border-hairline-soft outline-none hover:bg-surface-soft focus-visible:bg-surface-soft focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-inset data-[state=selected]:bg-surface-card',
                  row.kind !== 'conversation' && 'text-muted-soft',
                )}
              >
                <TableCell className="px-3 py-2 font-mono text-muted-foreground">
                  {formatClock(row.startedAt)}
                </TableCell>
                <TableCell className="max-w-[240px] truncate px-3 py-2">
                  <span className="font-mono text-body-strong">{row.path}</span>
                  {row.kind !== 'conversation' && (
                    <span className="ml-2 text-[12px] text-muted-soft">{row.kind}</span>
                  )}
                </TableCell>
                <TableCell className="px-3 py-2">
                  {row.error ? (
                    <StatusBadge tone="error">err</StatusBadge>
                  ) : row.status === undefined ? (
                    <StatusBadge tone="warning">…</StatusBadge>
                  ) : (
                    <StatusBadge tone={row.status >= 400 ? 'error' : 'success'}>{row.status}</StatusBadge>
                  )}
                </TableCell>
                <TableCell className="max-w-[160px] truncate px-3 py-2 font-mono text-[12.5px]">
                  {row.model ?? '—'}
                </TableCell>
                <TableCell className={NUM}>{formatMs(row.ttfbMs)}</TableCell>
                <TableCell className={NUM}>{formatMs(row.durationMs)}</TableCell>
                <TableCell className={cx(NUM, 'text-muted-foreground')}>
                  {formatBytes(row.responseBytes)}
                </TableCell>
                <TableCell className={NUM}>
                  {row.usage
                    ? `${formatTokens(row.usage.inputTokens)}/${formatTokens(row.usage.outputTokens)}`
                    : '—'}
                </TableCell>
                <TableCell className="px-3 py-2 font-mono text-[12.5px] text-muted-foreground">
                  {row.turnIndex !== undefined ? `#${row.turnIndex + 1}` : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
