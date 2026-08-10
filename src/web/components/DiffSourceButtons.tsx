import {
  toggleGitDiffSource,
  useGitDiff,
  type GitDiffSide,
  type GitDiffSource,
} from '../git-diff.js';
import { cx } from './ui.js';

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

function isSelected(selected: GitDiffSource | undefined, source: GitDiffSource): boolean {
  return (
    selected?.sourceId === source.sourceId &&
    selected.text === source.text &&
    selected.format === source.format
  );
}

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
  const label = side === 'left' ? 'Diff Left' : 'Diff Right';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={active ? `Remove from ${label}` : `Use this source as ${label}`}
      className={cx(
        'h-[26px] rounded-md border px-2.5 text-[12px] font-medium transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : surface === 'code'
            ? 'border-code-elevated bg-code-elevated text-code-fg-soft hover:text-code-fg'
            : 'border-hairline bg-canvas text-muted-foreground hover:border-muted-soft hover:text-ink',
      )}
    >
      {label}
    </button>
  );
}
