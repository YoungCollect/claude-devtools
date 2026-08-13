/**
 * The API, served by a directory of files instead of the local proxy.
 *
 * A preview build has no server: `dist/preview` is uploaded to GitHub Pages and
 * every read has to resolve to a static file. This module implements the same
 * calls `api` exposes, which is why `api.ts` can pick between the two without
 * anything downstream — App, Inspector, the trace views — knowing which one it
 * got.
 *
 * Three behaviours differ from the live API, and all three are honest rather
 * than simulated:
 *   - there is no change feed, so the revision stream reports one revision and
 *     stays connected forever;
 *   - the capture cannot be mutated, so `api.ts` hides Clear/rename/delete;
 *   - a payload that was never baked 404s, and the caller sees the same "not
 *     found" it would see for an evicted request.
 */

import type { StateSnapshot, TraceNode, TransportDetail } from '../core/types.js';
import {
  PREVIEW_INDEX_FILE,
  previewNodesFile,
  previewTransportFile,
  type PreviewIndex,
} from '../preview/paths.js';
import type { ServerConfig } from './api.js';

/**
 * Where the payload tree lives, as an absolute URL path.
 *
 * `BASE_URL` is the Vite base — `/` locally, `/<repo>/` on project Pages. Every
 * fetch goes through here because a preview is normally served from a
 * subdirectory, where a root-absolute `/preview-data/...` would miss.
 */
function assetUrl(relativePath: string): string {
  const base = import.meta.env.BASE_URL;
  return `${base.endsWith('/') ? base : `${base}/`}${relativePath}`;
}

async function getStatic<T>(relativePath: string): Promise<T> {
  const url = assetUrl(relativePath);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The index backs both `config()` and `state()`, and the app asks for them
 * separately on mount. Caching the promise — not the value — collapses that to
 * one request without either caller having to know about the other.
 */
let indexPromise: Promise<PreviewIndex> | undefined;

function loadIndex(): Promise<PreviewIndex> {
  indexPromise ??= getStatic<PreviewIndex>(PREVIEW_INDEX_FILE);
  return indexPromise;
}

export const previewApi = {
  config: async (): Promise<ServerConfig> => (await loadIndex()).config,
  state: async (): Promise<StateSnapshot> => (await loadIndex()).state,
  nodes: (conversationId: string): Promise<{ nodes: TraceNode[] }> =>
    getStatic(previewNodesFile(conversationId)),
  transport: (id: string): Promise<{ record: TransportDetail }> =>
    getStatic(previewTransportFile(id)),
  deleteConversation: readOnly('delete a conversation'),
  renameConversation: readOnly('rename a conversation'),
  clear: readOnly('clear the capture'),
};

/**
 * Rejects rather than resolving quietly. `api.ts` hides every control that
 * would reach these, so arriving here means a code path escaped that guard —
 * and a silent success would redraw the UI as though a published, immutable
 * page had been edited.
 */
function readOnly(action: string): (...args: unknown[]) => Promise<never> {
  return () =>
    Promise.reject(new Error(`This is a static preview — it cannot ${action}.`));
}

/** Metadata for the banner that tells a visitor what they are looking at. */
export async function previewMeta(): Promise<{ generatedAt: string; source: string }> {
  const { generatedAt, source } = await loadIndex();
  return { generatedAt, source };
}

/**
 * Stands in for the SSE subscription.
 *
 * Reports connected once and never revises: the data is a file that cannot
 * change while the page is open. The header's ready indicator is telling the
 * truth here — the "feed" really is up, it simply has nothing further to say.
 */
export function subscribeToPreviewRevisions({
  onRevision,
  onStatus,
}: {
  onRevision: (rev: number) => void;
  onStatus: (connected: boolean) => void;
}): () => void {
  onStatus(true);
  onRevision(0);
  return () => undefined;
}
