import { useSyncExternalStore } from 'react';

export type GitDiffSide = 'left' | 'right';
export type GitDiffFormat = 'markdown' | 'xml' | 'json';

export interface GitDiffSourceIdentity {
  /** Stable identity of the trace node or transport body. */
  sourceId: string;
  sessionId: string;
  label: string;
}

export interface GitDiffSource extends GitDiffSourceIdentity {
  text: string;
  format: GitDiffFormat;
}

/**
 * Which control opened the dialog, for the entrance it plays.
 *
 * Presentation, deliberately: only the tray can claim the dialog grew out of
 * something the user was looking at, because only the tray is a picture of the
 * dialog sitting at a known place on screen. Every other route — the header
 * button, the `G D` chord — has no origin to animate from and says so.
 */
export type GitDiffOrigin = 'tray' | 'elsewhere';

export interface GitDiffState {
  open: boolean;
  origin: GitDiffOrigin;
  left?: GitDiffSource;
  right?: GitDiffSource;
}

// Diff inputs can contain the same sensitive material as captured transports.
// Keep them in memory only: persisting this convenience state would silently
// create a second copy outside the trace retention and Clear lifecycle.
let state: GitDiffState = { open: false, origin: 'elsewhere' };
const listeners = new Set<() => void>();

function publish(next: GitDiffState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): GitDiffState {
  return state;
}

export function useGitDiff(): GitDiffState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function setGitDiffOpen(open: boolean, origin: GitDiffOrigin = 'elsewhere'): void {
  if (state.open === open) return;
  // A close keeps whatever origin the open set, so the exit can retrace the
  // entrance. Resetting it here would grow the dialog out of the corner and
  // then collapse it into the middle of the screen.
  publish({ ...state, open, origin: open ? origin : state.origin });
}

export function toggleGitDiffSource(side: GitDiffSide, source: GitDiffSource): void {
  const current = state[side];
  publish({
    ...state,
    [side]:
      current?.sourceId === source.sourceId &&
      current.text === source.text &&
      current.format === source.format
        ? undefined
        : source,
  });
}

export function clearGitDiffSide(side: GitDiffSide): void {
  if (state[side] === undefined) return;
  publish({ ...state, [side]: undefined });
}

export function clearGitDiff(): void {
  if (state.left === undefined && state.right === undefined) return;
  publish({ open: state.open, origin: state.origin });
}
