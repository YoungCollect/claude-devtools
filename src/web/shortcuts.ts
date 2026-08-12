const GIT_DIFF_WINDOW_MS = 1000;

export interface ShortcutResult {
  waitingUntil: number | undefined;
  openDiff: boolean;
  closeDiff?: true;
}

/** Interprets the app-level Git Diff chords without owning DOM events. */
export function gitDiffShortcut(
  waitingUntil: number | undefined,
  key: string,
  now: number,
): ShortcutResult {
  const normalized = key.toLowerCase();
  if (waitingUntil !== undefined && now <= waitingUntil && normalized === 'd') {
    return { waitingUntil: undefined, openDiff: true };
  }
  if (waitingUntil !== undefined && now <= waitingUntil && normalized === 'c') {
    return { waitingUntil: undefined, openDiff: false, closeDiff: true };
  }
  if (normalized === 'g') {
    return { waitingUntil: now + GIT_DIFF_WINDOW_MS, openDiff: false };
  }
  return { waitingUntil: undefined, openDiff: false };
}
