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

export interface GitDiffState {
  open: boolean;
  left?: GitDiffSource;
  right?: GitDiffSource;
}

// Diff inputs can contain the same sensitive material as captured transports.
// Keep them in memory only: persisting this convenience state would silently
// create a second copy outside the trace retention and Clear lifecycle.
let state: GitDiffState = { open: false };
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

export function setGitDiffOpen(open: boolean): void {
  if (state.open === open) return;
  publish({ ...state, open });
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
  publish({ open: state.open });
}
