import type { StateSnapshot, TraceNode } from '../core/types.js';
import { previewApi, subscribeToPreviewRevisions } from './preview-source.js';

export type { DerivedTiming, TransportDetail } from '../core/types.js';
import type { TransportDetail } from '../core/types.js';

/**
 * True in a build made by `pnpm preview:build`: the UI is reading baked JSON
 * from a static host, not a proxy on loopback.
 *
 * Defined at build time so the flag folds to a constant. Components branch on
 * it to hide the controls a published page cannot honour — Clear, rename,
 * delete — rather than offering them and failing at the fetch.
 */
export const IS_STATIC_PREVIEW: boolean = import.meta.env.VITE_STATIC_PREVIEW === 'true';

export interface ServerConfig {
  /** The loopback origin Claude Code points ANTHROPIC_BASE_URL at. */
  proxyUrl: string;
  /** Anthropic-compatible destination receiving all proxied traffic. */
  upstream: string;
  uiPort: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Marks a request as coming from this UI rather than from some other page the
 * browser has open. The header itself is not a secret — its job is to be
 * non-simple, so a cross-origin caller has to pass a preflight that this API
 * never answers. The server rejects state-changing requests without it.
 */
const MUTATION_HEADERS = { 'x-claude-devtools': '1' };

async function mutate(path: string, method: string, body?: unknown): Promise<void> {
  const res = await fetch(path, {
    method,
    headers:
      body === undefined
        ? MUTATION_HEADERS
        : { ...MUTATION_HEADERS, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
}

const liveApi = {
  config: () => getJson<ServerConfig>('/api/config'),
  state: () => getJson<StateSnapshot>('/api/state'),
  nodes: (conversationId: string) =>
    getJson<{ nodes: TraceNode[] }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/nodes`,
    ),
  deleteConversation: (conversationId: string) =>
    mutate(`/api/conversations/${encodeURIComponent(conversationId)}`, 'DELETE'),
  renameConversation: (conversationId: string, title: string) =>
    mutate(`/api/conversations/${encodeURIComponent(conversationId)}`, 'PATCH', { title }),
  transport: (id: string) =>
    getJson<{ record: TransportDetail }>(`/api/transport/${encodeURIComponent(id)}`),
  // Throws on a failed clear, so the caller does not refresh and present
  // unchanged data as if the wipe had succeeded.
  clear: () => mutate('/api/clear', 'POST'),
};

/**
 * The reads and writes the UI has, whichever source is behind them.
 *
 * Chosen once at module load from a build-time constant, so a preview bundle
 * never carries a path that could reach loopback and a normal build behaves
 * exactly as before.
 */
export const api: typeof liveApi = IS_STATIC_PREVIEW ? previewApi : liveApi;

/**
 * The server publishes a revision number rather than diffs; we refetch on every
 * bump. Volume is a single local agent's traffic, so this stays cheap and the
 * UI can never drift out of sync with the store.
 *
 * `onStatus` reports whether this stream is actually open, which is the only
 * honest source for the header's ready/offline distinction. Deriving it from the
 * refetches instead was self-fulfilling: a refetch only happens when a `rev`
 * arrives, so a server that had gone away simply stopped saying anything and
 * the indicator held at "ready" forever — it was reporting "a fetch succeeded
 * at some point", not "the feed is open".
 */
export function subscribeToRevisions({
  onRevision,
  onStatus,
}: {
  onRevision: (rev: number) => void;
  onStatus: (connected: boolean) => void;
}): () => void {
  // A static preview has no stream to open. Returning early keeps EventSource
  // from retrying a URL that will 404 for as long as the page is left open.
  if (IS_STATIC_PREVIEW) return subscribeToPreviewRevisions({ onRevision, onStatus });

  const source = new EventSource('/api/stream');
  source.addEventListener('rev', (event) => {
    onStatus(true);
    onRevision(Number((event as MessageEvent<string>).data));
  });
  // The server's 15s keep-alive. On a quiet capture it is the only traffic on
  // this stream, so it is what distinguishes "connected and quiet" from "gone".
  source.addEventListener('ping', () => onStatus(true));
  source.onopen = () => onStatus(true);
  // Fires on drop *and* on every failed reconnect attempt — EventSource retries
  // on its own, so this stays false until `onopen` says otherwise.
  source.onerror = () => onStatus(false);
  return () => source.close();
}
