import { useMemo, type ReactNode } from 'react';
import { Maximize2, PanelLeft, PanelRight, X } from 'lucide-react';

import {
  clearGitDiffSide,
  setGitDiffOpen,
  useGitDiff,
  type GitDiffSide,
  type GitDiffSource,
} from '../git-diff.js';
import { greekLines } from '../greeking.js';
import { cx } from './ui.js';

/** Both panes reserve this, so the tray keeps one height as sides fill in. */
const PANE_BODY = 'h-[84px]';

/**
 * The diff selection, parked in the corner until it is complete.
 *
 * Choosing a side is a two-part gesture with an unbounded gap in the middle:
 * you take a left source, then go looking for the thing to compare it against,
 * and that search can cross conversations and take minutes. Until now the only
 * record of the first half was the pressed state on one `DiffSourceButtons`
 * pair — hover-revealed, inside a block that may be collapsed, scrolled away,
 * or in another conversation entirely. A half-armed diff was invisible, so it
 * was forgettable, and the usual way to find out you still had one was to arm
 * the other side and get a comparison against something you had forgotten.
 *
 * The tray is a miniature of `GitDiffDialog`: the same split, left beside
 * right. That is what makes it readable at this size — a box with one side
 * filled and one side dashed says "still waiting" without being read, and it
 * says it in the layout you land in when the diff finally opens.
 *
 * It shows shape, never content. See `greekLines`.
 */
export function DiffTray() {
  const diff = useGitDiff();

  // Nothing selected is nothing to remember. Open, and the dialog is showing
  // both sources in full a few hundred pixels away.
  if (diff.open || (diff.left === undefined && diff.right === undefined)) return null;

  const ready = diff.left !== undefined && diff.right !== undefined;

  return (
    <aside
      aria-label="Diff selection"
      /*
        Docked to the viewport rather than to the trace column, because the
        selection outlives the conversation it was taken from: switch
        conversations to hunt for the other side and a tray anchored inside the
        trace would go with it. Below `md` the conversation sidebar becomes an
        overlay at `z-40` above its `z-30` scrim; `z-20` puts the tray under
        both, so an open sidebar covers it instead of being punched through.

        `left-8` centres the tray in that sidebar: 288px (`w-72`) less the
        tray's 224px (`w-56`), halved, is 32px. The tray owns nothing in the
        conversation list and says nothing about it, but sitting flush to one
        edge of a column it does not belong to reads as a misalignment rather
        than as a choice. Change either width and this number moves with them.
      */
      className="diff-tray-dock fixed bottom-4 left-8 z-20 w-56 overflow-hidden rounded-lg border border-hairline bg-canvas shadow-lg"
    >
      <div className="flex h-8 items-center border-b border-hairline pr-1.5 pl-2.5">
        <span className="text-[11px] font-medium tracking-[1px] text-muted-foreground uppercase">
          Diff
        </span>
        {/*
          One control in the header, and it is the only one that acts on the
          tray as a whole.

          There was a Clear beside it and the pair was the wrong shape: two
          equally sized glyphs 2px apart, one the next step and one the undo, in
          a header 224px wide. Removal belongs to the panes — you almost always
          want to replace *one* side, not drop both — and each already carries
          its own control. Emptying both retires the tray, so dismissing it is
          still reachable; it is spelled as taking the sources out rather than
          as hiding a tray that still holds them, which is the state this whole
          component exists to prevent.

          `Maximize2` rather than the app header's `Columns2`, because the two
          buttons do different jobs. The header's opens the diff feature, and a
          split-columns glyph is the right name for that. This one enlarges the
          panel it sits on — the tray *is* the diff, at 224px — so the glyph
          that carries information is the one about size, not about comparison.
          A second `Columns2` here would only restate the split already drawn
          underneath it.

          Filled once both sides are in: the tray stops being a reminder and
          becomes a next step. Position and size hold, so this reads as the same
          button having come live rather than as a new one appearing.
        */}
        <TrayIconButton
          label={ready ? 'Open the diff' : 'Open the diff — one side still to choose'}
          onClick={() => setGitDiffOpen(true)}
          tone={ready ? 'primary' : 'muted'}
          className="ml-auto size-5"
        >
          <Maximize2 size={12} aria-hidden />
        </TrayIconButton>
      </div>

      <div className="grid grid-cols-2 divide-x divide-hairline">
        <SourceThumbnail side="left" source={diff.left} />
        <SourceThumbnail side="right" source={diff.right} />
      </div>
    </aside>
  );
}

/**
 * The tray's own icon control, at the scale a 224px panel can carry.
 *
 * Below the 24px the toolbar buttons keep, because these sit inside a widget
 * that must not read as a second toolbar — the trade is deliberate and the
 * targets stay inside a header row that is itself the hit area for nothing
 * else. `label` feeds the accessible name and the tooltip from one prop, the
 * way `ToolbarIconButton` does, so an icon-only control can never end up
 * unnameable.
 */
function TrayIconButton({
  label,
  onClick,
  tone = 'muted',
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  /** `primary` marks the one control that is the obvious next move. */
  tone?: 'muted' | 'primary';
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cx(
        'flex shrink-0 items-center justify-center rounded outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        tone === 'primary'
          ? 'bg-primary text-primary-foreground hover:bg-primary/80'
          : 'text-muted-foreground hover:bg-surface-soft hover:text-ink',
        className ?? 'size-5',
      )}
    >
      {children}
    </button>
  );
}

/**
 * One side of the selection: its label over its greeked shape, or a dashed
 * well when nothing is chosen.
 *
 * The empty side is drawn, not omitted. A pane left blank reads as a source
 * with no content in it; the dashed edge and the side glyph say the slot is
 * waiting, which is the one thing the tray is here to communicate.
 */
function SourceThumbnail({ side, source }: { side: GitDiffSide; source?: GitDiffSource }) {
  const name = side === 'left' ? 'Diff Left' : 'Diff Right';
  const Icon = side === 'left' ? PanelLeft : PanelRight;

  if (source === undefined) {
    return (
      <div className="p-2">
        <div
          className={cx(
            PANE_BODY,
            'flex items-center justify-center rounded border border-dashed border-hairline text-muted-soft',
          )}
        >
          <Icon size={14} strokeWidth={2} aria-hidden />
          <span className="sr-only">No source chosen for {name}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="group/pane relative p-2">
      <button
        type="button"
        onClick={() => setGitDiffOpen(true)}
        title={`${name}: ${source.label} — open the diff`}
        className={cx(
          PANE_BODY,
          'flex w-full flex-col gap-1.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        {/*
          The label is identity, not content: `system prompt`, `user message`,
          the context tag. It is the one string that says *which* source this is
          once the text itself has been reduced to bars.
        */}
        <span className="w-full truncate text-[10px] font-medium tracking-[0.5px] text-muted-foreground uppercase">
          {source.label}
        </span>
        <Greeking text={source.text} />
      </button>
      <TrayIconButton
        label={`Remove from ${name}`}
        onClick={() => clearGitDiffSide(side)}
        className="absolute top-1 right-1 size-4 bg-canvas opacity-0 transition-opacity group-hover/pane:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <X size={10} aria-hidden />
      </TrayIconButton>
    </div>
  );
}

/**
 * The source as bars. `aria-hidden` because it carries no information a screen
 * reader can use — the pane's label and button name carry all of it.
 *
 * Widths are inline because they are measurements of this one source, not a
 * design decision there could be a token for. The colour is a token.
 */
function Greeking({ text }: { text: string }) {
  const widths = useMemo(() => greekLines(text), [text]);
  return (
    <div aria-hidden className="flex w-full flex-col gap-[3px]">
      {widths.map((width, index) => (
        <div
          key={index}
          className="h-[2px] rounded-full bg-data-divider"
          style={{ width: `${width * 100}%` }}
        />
      ))}
    </div>
  );
}
