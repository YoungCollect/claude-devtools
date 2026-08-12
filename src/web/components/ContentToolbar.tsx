import type { GitDiffFormat, GitDiffSourceIdentity } from '../git-diff.js';
import { DiffSourceButtons } from './DiffSourceButtons.js';
import { CopyIconButton, cx } from './ui.js';

export type ContentFormat = 'markdown' | 'xml';
export type ViewMode = ContentFormat | 'raw';

/**
 * Both rendered views carry the same first word, so the toggle reads as one
 * control with a qualifier rather than two unrelated names you have to
 * remember. `Structure` said nothing that `Rendered · XML` does not, and it
 * only ever appeared next to `Rendered` on the blocks that have both.
 */
export const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  markdown: 'Rendered · MD',
  xml: 'Rendered · XML',
  raw: 'Raw',
};

export interface ContentToolbarProps {
  /** What Copy puts on the clipboard, and what a diff selection captures. */
  text: string;
  /** Copy's tooltip. Name what is copied when it is not the panel's own source. */
  copyLabel?: string;
  /**
   * Diff selection, source and view in one prop.
   *
   * They travel together because a source without a format is not selectable:
   * the diff renders the text *as* something, and defaulting that would show
   * JSON as markdown at the one moment the user is comparing bytes.
   */
  diff?: { source: GitDiffSourceIdentity; format: GitDiffFormat };
  /** The Rendered/Raw toggle. Omit it and the row is diff plus copy. */
  viewModes?: {
    options: readonly ViewMode[];
    active: ViewMode;
    onSelect: (mode: ViewMode) => void;
  };
  /**
   * `card` is the panel header, with a rule under it. `bare` sits on a chat
   * bubble's own fill, separated by space instead of a line it would otherwise
   * draw across the middle of a turn. `inline` brings its own nothing — for a
   * host that already owns the padding, such as a `Section` header.
   */
  variant?: 'card' | 'bare' | 'inline';
  /** Which edge the row hangs off. See `ContentViewer.controlsAlign`. */
  align?: 'start' | 'end';
  /**
   * Which side of the content the row sits on — it owns the rule and the gap
   * that separate it from that content, so it has to know.
   */
  edge?: 'top' | 'bottom';
}

/**
 * The control row over a piece of captured text: diff selection, view mode,
 * copy.
 *
 * It lives apart from `ContentViewer` because the row is one decision — what
 * you can do to captured text, and in what order those controls read — while
 * the panel below it is another. Everything that shows captured text uses it,
 * chat bubbles and Inspector section headers alike, so the set of controls (or
 * the icons and tooltips they use) changes in one place rather than in each
 * caller. Each part is independent: a JSON body offers no view toggle, the raw
 * tab offers only copy.
 */
export function ContentToolbar({
  text,
  copyLabel,
  diff,
  viewModes,
  variant = 'card',
  align = 'end',
  edge = 'top',
}: ContentToolbarProps) {
  return (
    /*
      On a card the controls sit in the card's own header rather than floating
      above it. Outside, they read as chrome belonging to the row; inside and
      right aligned they read as what they are — a control over this one panel —
      and the card keeps a single unbroken edge instead of two stacked blocks.

      The header does not scroll with the body, so the mode you are in stays
      visible however far down a 20 kB prompt you are.
    */
    <div
      className={cx(
        'flex items-center gap-1.5',
        // `flex-row-reverse` runs the main axis right-to-left, so `justify-end`
        // packs the row against the left edge with the DOM order reversed —
        // one declaration pair gives both halves of the mirror.
        align === 'start' ? 'flex-row-reverse justify-end' : 'justify-end',
        variant === 'card' &&
          cx(
            'px-2 py-1.5',
            edge === 'top' ? 'border-b' : 'border-t',
            'border-data-divider',
          ),
        // Bare has no card edge for a rule to sit on, so the controls are
        // separated by space instead of a line.
        variant === 'bare' && (edge === 'top' ? 'pb-2' : 'pt-2'),
      )}
    >
      {diff && (
        <DiffSourceButtons source={{ ...diff.source, text, format: diff.format }} />
      )}
      {viewModes?.options.map((candidate) => (
        <button
          key={candidate}
          type="button"
          onClick={() => viewModes.onSelect(candidate)}
          aria-pressed={candidate === viewModes.active}
          className={cx(
            // Worded modes keep a little more height than the compact icon
            // controls beside them, preserving their distinct control shape.
            'h-8 rounded-md border px-2.5 text-[12px] font-medium transition-colors',
            candidate === viewModes.active
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-data-border bg-data-surface-control text-data-foreground-muted hover:text-data-foreground',
          )}
        >
          {VIEW_MODE_LABELS[candidate]}
        </button>
      ))}
      {/*
        Copy sits with the modes because what it copies is the source — the
        thing `Raw` shows — not the panel as a whole.
      */}
      <CopyIconButton text={text} title={copyLabel} />
    </div>
  );
}
