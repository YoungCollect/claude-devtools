import { PanelLeft, PanelRight } from 'lucide-react';

import {
  toggleGitDiffSource,
  useGitDiff,
  type GitDiffSide,
  type GitDiffSource,
} from '../git-diff.js';
import { ToolbarIconButton } from './ui.js';

export function DiffSourceButtons({
  source,
  surface = 'canvas',
}: {
  source: GitDiffSource;
  surface?: 'canvas' | 'code';
}) {
  const diff = useGitDiff();
  return (
    <>
      <DiffSourceButton
        side="left"
        active={isSelected(diff.left, source)}
        onClick={() => toggleGitDiffSource('left', source)}
        surface={surface}
      />
      <DiffSourceButton
        side="right"
        active={isSelected(diff.right, source)}
        onClick={() => toggleGitDiffSource('right', source)}
        surface={surface}
      />
    </>
  );
}

/**
 * Identity is the source and its view mode, never the text.
 *
 * A streaming assistant bubble's text changes on every frame while the diff
 * state holds the snapshot taken at click time. Comparing text made the button
 * un-press itself mid-response even though the source was still selected.
 */
function isSelected(selected: GitDiffSource | undefined, source: GitDiffSource): boolean {
  return selected?.sourceId === source.sourceId && selected.format === source.format;
}

/**
 * Icon-only, because these two sit in every bubble and every payload header:
 * two words apiece turned the control row into the loudest thing on a chat turn.
 * The panel glyphs carry the one distinction that matters — which side of the
 * diff this source lands on — and the tooltip carries the rest, including
 * whether a click selects or clears.
 */
function DiffSourceButton({
  side,
  active,
  onClick,
  surface,
}: {
  side: GitDiffSide;
  active: boolean;
  onClick: () => void;
  surface: 'canvas' | 'code';
}) {
  const name = side === 'left' ? 'Diff Left' : 'Diff Right';
  const Icon = side === 'left' ? PanelLeft : PanelRight;
  return (
    <ToolbarIconButton
      label={active ? `Remove from ${name}` : `Use this source as ${name}`}
      onClick={onClick}
      pressed={active}
      surface={surface}
    >
      <Icon size={13} strokeWidth={2} aria-hidden />
    </ToolbarIconButton>
  );
}
