import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import claudeCodeMark from '@lobehub/icons-static-svg/icons/claudecode.svg?raw';
import openaiMark from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import { cx } from './class-names.js';
import { buttonVariants } from './ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js';
import { cn } from '@/lib/utils';

/**
 * The agents this UI can be pointed at. First entry is the default.
 *
 * The marks come from `@lobehub/icons-static-svg` (MIT) rather than being
 * redrawn here: brand logos change, and a copy of one in this repo is a copy
 * that silently goes stale.
 */
export const AGENTS = [
  { id: 'claude-code', label: 'Claude Code', mark: claudeCodeMark },
  { id: 'openai', label: 'OpenAI', mark: openaiMark },
] as const;

export type AgentId = (typeof AGENTS)[number]['id'];

export const DEFAULT_AGENT: AgentId = AGENTS[0].id;

/**
 * A brand logo, inlined so it can take the colour of the control around it.
 *
 * The package ships plain SVG files whose fill is `currentColor` and whose box
 * is `1em`, so a mark inherits the button's colour and is sized by `font-size`.
 * The markup is inlined at build time from a dependency — never from captured
 * traffic, a header, or any other runtime string — which is what makes the
 * `dangerouslySetInnerHTML` here safe. An `<img src=…>` would render the same
 * file but lose `currentColor`, and the logo could no longer follow the theme.
 */
function BrandMark({ svg, size = 15 }: { svg: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center"
      style={{ fontSize: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * The header's agent picker: logos only, no words.
 *
 * Every option is a logo, so each one carries its name in `aria-label` and a
 * `title` — an icon-only menu that announces as "button, button" is unusable,
 * and a logo you do not recognise is unreadable without the hover name.
 *
 * The disclosure follows the same contract as the conversation actions menu:
 * pointer-down outside closes, Escape closes and returns focus to the trigger,
 * and the arrow keys walk the options.
 */
export function AgentSelect({
  value,
  onChange,
}: {
  value: AgentId;
  onChange: (id: AgentId) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = AGENTS.find((agent) => agent.id === value) ?? AGENTS[0];

  const focusTrigger = () => rootRef.current?.querySelector('button')?.focus();

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      focusTrigger();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  // Opening a menu moves focus onto an item, not the trigger — on the selected
  // one, so a keyboard user starts where they left off.
  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    const checked = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    (checked ?? items?.[0])?.focus();
  }, [open]);

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [],
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  };

  return (
    <div ref={rootRef} className="relative">
      <Tooltip>
        <TooltipTrigger
          type="button"
          aria-label={`Agent: ${current.label}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            buttonVariants({ variant: 'chrome' }),
            'gap-1 px-2 text-muted-foreground hover:text-ink',
          )}
        >
          <BrandMark svg={current.mark} />
          <ChevronDown size={13} aria-hidden />
        </TooltipTrigger>
        <TooltipContent>{current.label}</TooltipContent>
      </Tooltip>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Agent"
          onKeyDown={moveFocus}
          className="absolute top-10 right-0 z-30 flex flex-col gap-1 rounded-lg border border-hairline bg-canvas p-1 shadow-lg"
        >
          {AGENTS.map((agent) => (
            <button
              key={agent.id}
              type="button"
              role="menuitemradio"
              aria-checked={agent.id === value}
              aria-label={agent.label}
              title={agent.label}
              onClick={() => {
                onChange(agent.id);
                setOpen(false);
                focusTrigger();
              }}
              className={cx(
                'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
                agent.id === value
                  ? 'bg-surface-soft text-ink'
                  : 'text-muted-foreground hover:bg-surface-soft hover:text-ink',
              )}
            >
              <BrandMark svg={agent.mark} size={16} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
