import { useState, type ReactNode } from 'react';

export function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Badge tones name a role, not a hue — `tool` is amber in light and purple in
 * dark, and no component has to know that. `primary` is deliberately rare:
 * the accent stays reserved for selection and active state, so a trace full of
 * badges never dilutes it.
 */
export type Tone = 'neutral' | 'emph' | 'primary' | 'success' | 'tool' | 'warning' | 'error';

const TONES: Record<Tone, string> = {
  neutral: 'bg-neutral-bg text-neutral-fg',
  emph: 'bg-emph-bg text-emph-fg',
  primary: 'bg-primary text-primary-fg',
  success: 'bg-assistant-bg text-assistant-fg',
  tool: 'bg-tool-bg text-tool-fg',
  warning: 'bg-warning-bg text-warning-fg',
  error: 'bg-error-bg text-error-fg',
};

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[12px] leading-5 font-medium',
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Uppercase category badge — 12px / 500 / 1.5px tracking, per the system. */
export function TagLabel({ children, tone = 'emph' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[11px] leading-5 font-medium tracking-[1.5px] uppercase',
        TONES[tone],
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
    <div className="flex items-center gap-1 px-3">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={cx(
            'rounded-md px-3 py-1.5 text-[14px] font-medium transition-colors',
            active === tab.id
              ? 'bg-surface-card text-ink'
              : 'text-muted hover:bg-surface-soft hover:text-body-strong',
          )}
          aria-current={active === tab.id ? 'page' : undefined}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="ml-2 font-mono text-[12px] text-muted-soft">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * The `code-window-card`. In light it is the system's dark navy card on cream —
 * where the cream-to-dark contrast does real work, making payloads read as
 * product chrome rather than as more page. In dark the same role inverts to a
 * raised panel, which is why the border token exists: it is invisible in light
 * and load-bearing in dark.
 */
export function CodeBlock({ text, className }: { text: string; className?: string }) {
  if (!text) return <Empty>No content</Empty>;
  return (
    <div
      className={cx('on-code overflow-hidden rounded-lg border border-code-border bg-code', className)}
    >
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap text-code-fg">
        {text}
      </pre>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-1 py-4 text-[14px] text-muted-soft italic">{children}</div>;
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
    <div className="border-b border-hairline-soft last:border-0">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-[12px] font-medium tracking-[1.5px] text-muted uppercase hover:text-ink"
        >
          <Chevron open={open} />
          {title}
        </button>
        {action}
      </div>
      {open && <div className="px-4 pb-4">{children}</div>}
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
      <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function KeyValue({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-2 text-[13px]">
      {rows.map(([key, value], i) => (
        <div key={`${key}-${i}`} className="contents">
          <dt className="truncate text-muted">{key}</dt>
          <dd className="font-mono text-[12.5px] break-all text-body-strong">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** `button-secondary`: canvas fill, hairline outline, 8px radius. */
export function Button({
  children,
  onClick,
  active = false,
  tone = 'default',
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  tone?: 'default' | 'danger';
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cx(
        'rounded-md border px-3 py-1 text-[13px] font-medium transition-colors',
        active
          ? 'border-primary bg-primary text-primary-fg'
          : tone === 'danger'
            ? 'border-hairline bg-canvas text-muted hover:border-error-fg hover:text-error-fg'
            : 'border-hairline bg-canvas text-body hover:border-muted-soft hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

/**
 * Palette switch. Light is the Claude design system; dark is the original
 * terminal-adjacent palette. The icon shows the theme you would switch *to*,
 * which is the convention every devtool uses.
 */
export function ThemeToggle({ theme, onToggle }: { theme: 'light' | 'dark'; onToggle: () => void }) {
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={onToggle}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-canvas text-muted transition-colors hover:border-muted-soft hover:text-ink"
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="12" cy="12" r="4.2" />
      <path
        strokeLinecap="round"
        d="M12 2.6v2.2M12 19.2v2.2M21.4 12h-2.2M4.8 12H2.6M18.6 5.4l-1.6 1.6M7 17l-1.6 1.6M18.6 18.6 17 17M7 7 5.4 5.4"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z"
      />
    </svg>
  );
}

/**
 * The radial spike mark that prefixes the wordmark in this system. Drawn
 * inline so the app carries no external asset.
 */
export function SpikeMark({ size = 16 }: { size?: number }) {
  const spokes = Array.from({ length: 8 }, (_, i) => (i * 360) / 8);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0">
      {spokes.map((angle) => (
        <path
          key={angle}
          d="M12 12 L11.05 2.6 Q12 1.4 12.95 2.6 Z"
          fill="currentColor"
          transform={`rotate(${angle} 12 12)`}
        />
      ))}
    </svg>
  );
}
