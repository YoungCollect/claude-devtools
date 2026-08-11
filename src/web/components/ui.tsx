import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';

import { DataSurface, DataSurfaceBody } from './DataSurface.js';
import { cx } from './class-names.js';
import { buttonVariants } from './ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js';
import { cn } from '@/lib/utils';

export { cx } from './class-names.js';

/**
 * Badge tones name a role, not a hue — `tool` is amber in light and purple in
 * dark, and no component has to know that. `primary` is deliberately rare:
 * the accent stays reserved for selection and active state, so a trace full of
 * badges never dilutes it.
 */
type MetaTone = 'neutral' | 'emph' | 'tool' | 'warning' | 'primary';
export type RoleTone = 'user' | 'assistant' | 'system' | 'context' | 'thinking' | 'tool' | 'error';
type StatusTone = 'success' | 'warning' | 'error';

const META_TONES: Record<MetaTone, string> = {
  neutral: 'bg-neutral-bg text-neutral-fg',
  emph: 'bg-emph-bg text-emph-fg',
  primary: 'bg-primary text-primary-foreground',
  tool: 'bg-tool-bg text-tool-fg',
  warning: 'bg-warning-bg text-warning-fg',
};

const STATUS_TONES: Record<StatusTone, string> = {
  success: 'bg-status-success-bg text-status-success-fg',
  warning: 'bg-status-warning-bg text-status-warning-fg',
  error: 'bg-status-error-bg text-status-error-fg',
};

const ROLE_TONES: Record<RoleTone, string> = {
  user: 'bg-role-user-bg text-role-user-fg',
  assistant: 'bg-role-assistant-bg text-role-assistant-fg',
  system: 'bg-role-system-bg text-role-system-fg',
  context: 'bg-role-context-bg text-role-context-fg',
  thinking: 'bg-role-thinking-bg text-role-thinking-fg',
  tool: 'bg-role-tool-bg text-role-tool-fg',
  error: 'bg-role-error-bg text-role-error-fg',
};

function Badge({
  children,
  toneClass,
  title,
}: {
  children: ReactNode;
  toneClass: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[12px] leading-5 font-medium',
        toneClass,
      )}
    >
      {children}
    </span>
  );
}

/**
 * `Badge` split three ways, per the product design audit's P2-02: status,
 * role and metadata badges read as the same pill but answer different
 * questions, and the old single `Tone` union let any of them borrow any
 * other's colour (a "pending" count in `error` red, say) with nothing to
 * catch it. Each wrapper narrows `Tone` to the tones that question actually
 * has an answer for; `Badge` itself stays as the shared rendering primitive
 * underneath all three, so there is still exactly one pill implementation.
 */

/** An outcome: an HTTP status, pass/fail, error/pending counts. */
export function StatusBadge({
  children,
  tone,
  title,
}: {
  children: ReactNode;
  tone: 'success' | 'error' | 'warning';
  title?: string;
}) {
  return (
    <Badge toneClass={STATUS_TONES[tone]} title={title}>
      {children}
    </Badge>
  );
}

/** Context that is not an outcome: a count, a duration, a format label. */
export function MetaBadge({
  children,
  tone = 'emph',
  title,
}: {
  children: ReactNode;
  tone?: MetaTone;
  title?: string;
}) {
  return (
    <Badge toneClass={META_TONES[tone]} title={title}>
      {children}
    </Badge>
  );
}

/**
 * Uppercase category badge — 12px / 500 / 1.5px tracking, per the system.
 * This is the role API: `user` / `assistant` / `system` / `tool` / `context`,
 * and the sidebar's `subagent` marker.
 */
export function TagLabel({ children, role }: { children: ReactNode; role: RoleTone }) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[11px] leading-5 font-medium tracking-[1.5px] uppercase',
        ROLE_TONES[role],
      )}
    >
      {children}
    </span>
  );
}

/** Ids shared by a tab and the panel it controls. */
export const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
export const tabPanelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

/** Props for the region a `Tabs` switches between. */
export function tabPanelProps(prefix: string, active: string) {
  return {
    role: 'tabpanel',
    id: tabPanelId(prefix, active),
    'aria-labelledby': tabId(prefix, active),
  } as const;
}

/**
 * A set of mutually exclusive views.
 *
 * The ARIA roles and the keyboard model are one decision, not two. These were
 * plain buttons marked `aria-current="page"` — the semantic for "the current
 * page among a set of links" — so assistive technology heard two buttons and
 * nothing about them being alternatives. Adding the roles without arrow-key
 * navigation would be worse than leaving them off: it announces a contract the
 * widget does not honour. So both arrive together, with the roving tabindex the
 * pattern requires (only the active tab is in the tab order; arrows move within
 * the set).
 */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  idPrefix,
  label,
  className,
}: {
  tabs: readonly { id: T; label: string; count?: number }[];
  active: T;
  onChange: (id: T) => void;
  /** Namespaces the tab/panel ids; must match the `tabPanelProps` call. */
  idPrefix: string;
  /** Names the set for assistive technology, e.g. "Views". */
  label: string;
  /**
   * Extra classes on the `tablist` root. Pass `w-max` when the caller wraps
   * this in its own `overflow-x-auto` — without it a plain-block ancestor
   * stretches the flex row to its own width and the tabs squeeze instead of
   * overflowing (Inspector's rail, at seven tabs on a narrow viewport).
   */
  className?: string;
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number | 'first' | 'last'> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      Home: 'first',
      End: 'last',
    };
    const step = keys[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === active);
    const next =
      step === 'first'
        ? 0
        : step === 'last'
          ? tabs.length - 1
          : // Wraps, which is what the pattern specifies for a horizontal set.
            (index + step + tabs.length) % tabs.length;
    const target = tabs[next];
    if (!target) return;
    onChange(target.id);
    event.currentTarget.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId(idPrefix, target.id))}`)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={move}
      className={cx('flex items-center gap-1 px-3', className)}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={tabId(idPrefix, tab.id)}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          aria-controls={tabPanelId(idPrefix, tab.id)}
          tabIndex={active === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          className={cx(
            'rounded-md px-3 py-1.5 text-[14px] font-medium transition-colors',
            active === tab.id
              ? 'bg-surface-card text-ink'
              : 'text-muted-foreground hover:bg-surface-soft hover:text-body-strong',
          )}
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

/** A `DataSurface` block holding one span of source text. */
export function CodeBlock({ text, className }: { text: string; className?: string }) {
  if (!text) return <Empty>No content</Empty>;
  return (
    <DataSurface variant="block" className={className}>
      <DataSurfaceBody maxHeightClass="max-h-[70vh]">
        <pre className="p-4 font-mono text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap text-data-foreground">
          {text}
        </pre>
      </DataSurfaceBody>
    </DataSurface>
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
  open: openProp,
  onOpenChange,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /**
   * Controlled open state. Omit it and the section owns its own — pass it when
   * something outside the header has to open the section, as the drill-down
   * from a trace node does.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  const toggle = () => {
    setUncontrolled(!open);
    onOpenChange?.(!open);
  };
  // `useId`, not the title: `Payload` and `Response` both render a section
  // titled "Body", and a title-derived id is only unique because `TabBody`
  // happens to mount one tab at a time — an invariant nothing enforces and a
  // future side-by-side layout would quietly break into duplicate ids.
  const contentId = `section-${useId()}`;
  return (
    <div className="border-b border-hairline-soft last:border-0">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          // Only while the panel is actually in the DOM — `aria-controls`
          // pointing at an id that does not exist is a dangling reference, and
          // `aria-expanded={false}` already carries the collapsed state.
          aria-controls={open ? contentId : undefined}
          className="flex items-center gap-2 text-[12px] font-medium tracking-[1.5px] text-muted-foreground uppercase hover:text-ink"
        >
          <Chevron open={open} />
          {title}
        </button>
        {action}
      </div>
      {open && (
        <div id={contentId} className="px-4 pb-4">
          {children}
        </div>
      )}
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
          <dt className="truncate text-muted-foreground">{key}</dt>
          <dd className="font-mono text-[12.5px] break-all text-body-strong">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Copy plus the short-lived "it worked" state, shared by every copy control.
 *
 * Exported so nothing has to reimplement it: a hand-rolled
 * `void navigator.clipboard.writeText(x)` loses both halves — the feedback and
 * the rejection handling — and a refused clipboard then surfaces as an
 * unhandled rejection.
 */
export function useCopy(): [copied: boolean, copy: (text: string) => void] {
  const [copied, setCopied] = useState(false);
  return [
    copied,
    (text: string) => {
      void navigator.clipboard.writeText(text).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        },
        // A refused clipboard (permission denied, no user gesture) must not
        // surface as an unhandled rejection. The button simply stays unchanged,
        // which is the honest signal: nothing was copied.
        () => {},
      );
    },
  ];
}

/*
 * There is no worded `CopyButton`. Every copy control in the app is an icon:
 * the one below for payloads, reached through `ContentToolbar`, and the
 * header's shell mark for the run command. They stay separate components
 * because they say different things — one takes a payload away, the other
 * hands you a command to run — but neither spends header or toolbar width on
 * the word "Copy".
 */

/**
 * Square icon control sized for the content toolbar, with its name carried by a
 * tooltip instead of a visible word.
 *
 * The name is not optional decoration: an icon-only row is unreadable without
 * it, so the label feeds `aria-label` *and* the tooltip from one prop — they
 * cannot drift apart, and the control is nameable by assistive technology even
 * when no pointer ever hovers it.
 *
 * `closeOnClick` is off because these controls change meaning when pressed
 * ("Use as Diff Left" becomes "Remove from Diff Left", Copy becomes Copied).
 * Dismissing the tooltip on click would hide the very state change the click
 * caused.
 */
export function ToolbarIconButton({
  label,
  onClick,
  pressed,
  confirmed = false,
  children,
}: {
  /** Names the control for both the tooltip and assistive technology. */
  label: string;
  onClick: () => void;
  /** Set only for toggles — it declares the button a toggle to screen readers. */
  pressed?: boolean;
  /** Momentary success outline, e.g. Copy's tick. */
  confirmed?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        onClick={onClick}
        aria-pressed={pressed}
        aria-label={label}
        closeOnClick={false}
        className={cx(
          // The icon itself stays the same size; the hit area is 32px — the
          // WCAG 2.2 AA minimum is 24px and 26px already cleared it, but a
          // uniform 32px target across the toolbar costs nothing else on the
          // row (P2-03).
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors',
          pressed
            ? 'border-primary bg-primary text-primary-foreground'
            : confirmed
              ? 'border-success bg-data-surface-control text-success-fg'
              : 'border-data-border bg-data-surface-control text-data-foreground-muted hover:text-data-foreground',
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Square copy button, sized to sit in a row of view-mode toggles.
 *
 * It carries no visible label because it sits directly beside the mode buttons,
 * where a word would read as a fourth mode. The tick replaces the icon rather
 * than appearing next to it, so the button never changes width mid-interaction.
 */
export function CopyIconButton({
  text,
  title = 'Copy source',
}: {
  text: string;
  title?: string;
}) {
  const [copied, copy] = useCopy();
  const label = copied ? 'Copied' : title;
  return (
    <ToolbarIconButton
      label={label}
      onClick={() => copy(text)}
      confirmed={copied}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </ToolbarIconButton>
  );
}

function CopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="9" width="12" height="12" rx="2.5" />
      <path d="M5.5 15H4.5A1.5 1.5 0 0 1 3 13.5V4.5A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
    </svg>
  );
}

/**
 * A control in the header's right-hand cluster.
 *
 * The cluster is icon-only end to end — shell, diff, clear, theme — because a
 * row that mixes glyphs with words reads as two different kinds of control and
 * makes the worded ones look like the primary action. The name is not lost: it
 * feeds `aria-label` and the tooltip from a single prop, so the pointer and the
 * screen reader always hear the same name.
 *
 * It borrows the `chrome` button's fill and hairline (one CVA definition, not a
 * hand-rolled lookalike) and only adds the danger tone, which no worded button
 * needed: `Clear` armed has to *look* destructive once it stops saying so.
 */
export function HeaderIconButton({
  label,
  onClick,
  tone = 'neutral',
  expanded,
  children,
}: {
  /** Names the control for both the tooltip and assistive technology. */
  label: string;
  onClick: () => void;
  /** `danger` is the armed/destructive state, e.g. Clear waiting to confirm. */
  tone?: 'neutral' | 'danger';
  /** Set only by a disclosure — it declares the button a panel trigger. */
  expanded?: boolean;
  children: ReactNode;
}) {
  const isDisclosure = expanded !== undefined;
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-haspopup={isDisclosure ? 'dialog' : undefined}
        aria-expanded={expanded}
        // Most of these controls change meaning when pressed (Clear arms, the
        // shell mark ticks), and dismissing the tooltip on click would hide the
        // very state change the click caused. A disclosure is the opposite: its
        // tooltip would sit on top of the panel it just opened.
        closeOnClick={isDisclosure}
        className={cn(
          buttonVariants({ variant: 'chrome', size: 'icon' }),
          'text-muted-foreground hover:text-ink',
          tone === 'danger' && 'border-error-fg bg-error-bg text-error-fg hover:text-error-fg',
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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
    <HeaderIconButton label={`Switch to ${next} theme`} onClick={onToggle}>
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </HeaderIconButton>
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
