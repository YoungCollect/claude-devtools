import { lazy } from 'react';

import type {
  PreloadMultiFileDiffOptions,
  PreloadMultiFileDiffResult,
} from '@pierre/diffs/ssr';

/**
 * The diff renderer's two halves, and the one place that decides when they load.
 *
 * `@pierre/diffs` splits across two entry points — `ssr` prerenders the diff to
 * HTML, `react` mounts it — and between them they pull about a megabyte of
 * chunks: the renderer itself, a wasm highlighter, and Shiki's grammars and
 * themes. None of it belongs in the initial bundle for a view most sessions
 * never open.
 *
 * What it must not do is load that megabyte on the critical path. Before this
 * module the two imports ran end to end *after* the dialog's open animation
 * finished — the React half is only referenced once the prerender resolves, so
 * its fetch could not even start until the prerender was done. Three serial
 * stages, none of them begun until the animation was over.
 *
 * So the loads live here, deduplicated, and callers choose when to start them:
 * `warmDiffRenderer` at the moment a diff becomes likely, the two accessors
 * when it is actually needed. A caller that skips the warm-up is slower, never
 * wrong.
 */

let ssrModule: Promise<typeof import('@pierre/diffs/ssr')> | undefined;
let reactModule: Promise<typeof import('@pierre/diffs/react')> | undefined;

/*
  A rejected import is not cached. Failures here are transient — a dev server
  restarting mid-session, a chunk that lost the network — and holding the
  rejected promise would disable the diff for the rest of the session with no
  way back short of a reload.
*/
function loadSsr(): Promise<typeof import('@pierre/diffs/ssr')> {
  ssrModule ??= import('@pierre/diffs/ssr').catch((error: unknown) => {
    ssrModule = undefined;
    throw error;
  });
  return ssrModule;
}

function loadReact(): Promise<typeof import('@pierre/diffs/react')> {
  reactModule ??= import('@pierre/diffs/react').catch((error: unknown) => {
    reactModule = undefined;
    throw error;
  });
  return reactModule;
}

/**
 * Start fetching both halves, without waiting for either.
 *
 * Idempotent and safe to call on every render of whatever is watching. Callers
 * want the side effect, not the result: a rejection here is swallowed on
 * purpose, because a warm-up that fails must not surface as an unhandled
 * rejection for a diff the user may never open. The real attempt reports its
 * own failure.
 */
export function warmDiffRenderer(): void {
  void loadSsr().catch(() => undefined);
  void loadReact().catch(() => undefined);
}

/** Prerender a comparison to HTML, loading the `ssr` half if it is not in yet. */
export async function prerenderDiff<LAnnotation>(
  options: PreloadMultiFileDiffOptions<LAnnotation>,
): Promise<PreloadMultiFileDiffResult<LAnnotation>> {
  const { preloadMultiFileDiff } = await loadSsr();
  return preloadMultiFileDiff(options);
}

/**
 * The mounted diff.
 *
 * `lazy` runs its factory once and caches the result, and the factory awaits
 * the same promise `warmDiffRenderer` primed — so a warmed chunk is already in
 * memory here rather than being fetched a second time.
 */
export const MultiFileDiff = lazy(async () => ({
  default: (await loadReact()).MultiFileDiff,
}));
