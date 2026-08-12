import type {
  AssembledResponse,
  RequestInspection,
  StateSnapshot,
  TraceNode,
  TransportRecord,
} from '../core/types.js';

export interface DerivedTiming {
  totalMs?: number;
  ttfbMs?: number;
  firstTokenMs?: number;
  streamMs?: number;
  frameCount: number;
}

export type TransportDetail = TransportRecord & {
  derivedTiming: DerivedTiming;
  assembledResponse?: AssembledResponse;
  requestInspection?: RequestInspection;
};

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

export const api = {
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
  transport: (id: string, reveal: boolean) =>
    getJson<{ record: TransportDetail }>(
      `/api/transport/${encodeURIComponent(id)}${reveal ? '?reveal=1' : ''}`,
    ),
  // Throws on a failed clear, so the caller does not refresh and present
  // unchanged data as if the wipe had succeeded.
  clear: () => mutate('/api/clear', 'POST'),
};

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
