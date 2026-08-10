import { useState, type ReactNode } from 'react';

export function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'tool' | 'ok' | 'warn' | 'danger';
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-ink-800 text-ink-300 ring-ink-700',
    accent: 'bg-accent/10 text-accent ring-accent/30',
    tool: 'bg-tool/10 text-tool ring-tool/30',
    ok: 'bg-ok/10 text-ok ring-ok/30',
    warn: 'bg-warn/10 text-warn ring-warn/30',
    danger: 'bg-danger/10 text-danger ring-danger/30',
  };
  return (
    <span
      title={title}
      className={cx(
        'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[10px] leading-4 ring-1 ring-inset',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: readonly { id: T; label: string; count?: number }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 border-b border-ink-800 px-2">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={cx(
            'relative -mb-px border-b-2 px-2.5 py-1.5 text-[12px] transition-colors',
            active === tab.id
              ? 'border-accent text-ink-100'
              : 'border-transparent text-ink-400 hover:text-ink-300',
          )}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="ml-1.5 font-mono text-[10px] text-ink-400">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Monospace block for payloads. Wraps long lines rather than hiding them. */
export function CodeBlock({ text, className }: { text: string; className?: string }) {
  if (!text) return <Empty>No content</Empty>;
  return (
    <pre
      className={cx(
        'overflow-x-auto rounded border border-ink-800 bg-ink-900 p-2.5 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap break-words text-ink-300',
        className,
      )}
    >
      {text}
    </pre>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-1 py-3 text-[12px] text-ink-400 italic">{children}</div>;
}

export function Section({
  title,
  action,
  children,
  defaultOpen = true,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-ink-800 last:border-0">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-ink-300 uppercase hover:text-ink-100"
        >
          <Chevron open={open} />
          {title}
        </button>
        {action}
      </div>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 10 10"
      className={cx('shrink-0 transition-transform', open && 'rotate-90')}
      aria-hidden
    >
      <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function KeyValue({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(90px,auto)_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
      {rows.map(([key, value], i) => (
        <div key={`${key}-${i}`} className="contents">
          <dt className="truncate text-ink-400">{key}</dt>
          <dd className="break-all text-ink-100">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="rounded border border-ink-700 px-1.5 py-0.5 font-mono text-[10px] text-ink-400 hover:border-ink-600 hover:text-ink-100"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
