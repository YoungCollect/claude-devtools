import type { ReactNode } from 'react';
import { cx } from './class-names.js';

/**
 * The one component every piece of structured or machine text renders
 * through — JSON, XML source, SSE frames, Raw request/response, tool
 * input/output, the header run command.
 *
 * Before this, `CodeBlock`, the JSON tree, the SSE frame list, `ToolPane` and
 * the header command each hand-assembled their own background, border,
 * radius and scroll behaviour against the same `code`/`chat-code` tokens —
 * so the container contract could (and did) drift between them. This is the
 * `DataSurface` the 2026-08-11 product design audit asked for (P1-01):
 * one container, one set of `data-*` tokens, and the difference between
 * "this is JSON" and "this is a raw SSE frame" is expressed through
 * `DataSurfaceHeader`'s format label and syntax colour, never through a
 * different background.
 *
 * The dependency-neutral `cx` helper keeps this primitive independent from
 * the larger `ui.tsx` compatibility barrel.
 */
export type DataSurfaceVariant = 'block' | 'nested' | 'rows' | 'inline';

const CONTAINER: Record<DataSurfaceVariant, string> = {
  // The subject of the tab/panel: JSON body, Raw request/response, the
  // assembled-response text. Sits directly on the canvas.
  block: 'overflow-hidden rounded-lg border border-data-border bg-data-surface',
  // One step in — a tool call's input/result inside its card, an expanded SSE
  // frame inside the frame list. Never sits directly on the canvas.
  nested: 'overflow-hidden rounded-md border border-data-border bg-data-surface-nested',
  // A block whose body is a list of rows sharing one divider colour, e.g. the
  // SSE frame list.
  rows: 'overflow-hidden rounded-lg border border-data-border bg-data-surface',
  // A single line of chrome, e.g. the header run command.
  inline:
    'inline-flex min-w-0 items-center gap-2.5 rounded-lg border border-data-border bg-data-surface py-1.5 pr-1.5 pl-3.5',
};

export function DataSurface({
  variant = 'block',
  className,
  children,
}: {
  variant?: DataSurfaceVariant;
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx(CONTAINER[variant], className)}>{children}</div>;
}

/**
 * The panel's own toolbar: a format label (`json`, `sse`, `raw`…) on the
 * left, actions (Copy, Diff, view mode) on the right. Optional — a `rows`
 * panel with its own per-row chrome (the SSE list) skips it.
 */
export function DataSurfaceHeader({
  format,
  actions,
  className,
}: {
  format?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex items-center gap-2 border-b border-data-divider px-2.5 py-1.5',
        className,
      )}
    >
      {format && (
        <span className="font-mono text-[11px] font-medium tracking-[1.5px] text-data-foreground-muted uppercase">
          {format}
        </span>
      )}
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/**
 * The panel's content. Scrolls by default, with a `.scroll-surface` bar
 * (visible on hover/focus, not hidden outright — P1-02) rather than a fixed
 * `max-h` that clips silently.
 */
export function DataSurfaceBody({
  className,
  scroll = true,
  maxHeightClass,
  children,
}: {
  className?: string;
  scroll?: boolean;
  maxHeightClass?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx(scroll && 'scroll-surface overflow-auto', maxHeightClass, className)}>
      {children}
    </div>
  );
}

/** Rows sharing the panel's divider colour — the SSE frame list's shape. */
export function DataSurfaceRows({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('divide-y divide-data-divider', className)}>{children}</div>;
}
