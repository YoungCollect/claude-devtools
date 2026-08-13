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
const NUM = 'px-3 py-2 font-mono text-[12.5px]';

/**
 * The table is `table-fixed`, so these header widths — not the widest cell in
 * each column — decide the layout. Auto sizing gave the short metric columns
 * the leftover space and left `path` and `model` stranded against wide gaps;
 * fixed shares keep the columns evenly distributed at any window width.
 */
const COL = {
  turn: 'w-[8%]',
  time: 'w-[12%]',
  path: 'w-[20%]',
  status: 'w-[12%]',
  model: 'w-[15%]',
  ttfb: 'w-[10%]',
  total: 'w-[9%]',
  size: 'w-[9%]',
  tokens: 'w-[8%]',
} as const;

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
      <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-4.25">
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
        {/*
          Announced only while a filter is active. As a permanent live region
          this reads out on every captured request, and against a live proxy
          that is a continuous stream of announcements nobody asked for; the
          count is feedback for *typing*, so it speaks when there is a query
          and stays a plain label otherwise.
        */}
        <span
          {...(query ? { role: 'status', 'aria-live': 'polite' as const } : {})}
          className="ml-auto text-[13px] text-muted-foreground"
        >
          {rows.length} requests
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="flex-1 overflow-auto">
          <Empty>No requests captured yet.</Empty>
        </div>
      ) : (
        <Table
          containerClassName="scroll-surface min-h-0 flex-1 overflow-auto"
          className="min-w-200 table-fixed text-[13px]"
        >
          <TableHeader className="sticky top-0 z-10 bg-surface-soft">
            <TableRow className="hover:bg-surface-soft">
              <TableHead className={cx(HEAD, COL.turn)}>turn</TableHead>
              <TableHead className={cx(HEAD, COL.time)}>time</TableHead>
              <TableHead className={cx(HEAD, COL.path)}>path</TableHead>
              <TableHead className={cx(HEAD, COL.status)}>status</TableHead>
              <TableHead className={cx(HEAD, COL.model)}>model</TableHead>
              <TableHead className={cx(HEAD, COL.ttfb)}>ttfb</TableHead>
              <TableHead className={cx(HEAD, COL.total)}>total</TableHead>
              <TableHead className={cx(HEAD, COL.size)}>size</TableHead>
              <TableHead className={cx(HEAD, COL.tokens)}>tokens</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.id}
                onClick={() => onSelect(row.id)}
                // `data-state` is shadcn's own selected-row hook; the fill it
                // resolves to is this system's selected surface, not the default.
                data-state={row.id === selectedId ? 'selected' : undefined}
                className={cx(
                  'cursor-pointer border-hairline-soft hover:bg-surface-soft has-[:focus-visible]:bg-surface-soft data-[state=selected]:bg-surface-card',
                  row.kind !== 'conversation' && 'text-muted-soft',
                )}
              >
                <TableCell className="px-3 py-2 font-mono text-[12.5px] text-muted-foreground">
                  {row.turnIndex !== undefined ? `#${row.turnIndex + 1}` : '—'}
                </TableCell>
                <TableCell className="px-3 py-2 font-mono text-muted-foreground">
                  {formatClock(row.startedAt)}
                </TableCell>
                <TableCell className="truncate px-3 py-2">
                  {/*
                    The row's keyboard entry point is a real button in the path
                    cell, not `tabIndex`/`role="button"` on the `<tr>` itself:
                    a row carrying the button role makes its nine `<td>`s
                    invalid children and drops them out of the accessibility
                    tree, so a screen-reader user would lose every column
                    except the row's own label. This keeps `row`/`cell`
                    semantics and table navigation intact, and gives the action
                    one properly named control. It has no `onClick` of its own —
                    both mouse clicks and Enter/Space produce a click event
                    that bubbles to the row handler above, which is also what
                    preserves click-anywhere-on-the-row for the mouse.
                  */}
                  <button
                    type="button"
                    aria-label={`Inspect ${row.method} ${row.path}${
                      row.status !== undefined ? `, status ${row.status}` : ''
                    }`}
                    className="max-w-full cursor-pointer truncate rounded-xs text-left font-mono text-body-strong outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  >
                    {row.path}
                  </button>
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
                <TableCell className="truncate px-3 py-2 font-mono text-[12.5px]">
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
