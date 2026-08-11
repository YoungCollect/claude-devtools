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
  proxyUrl: string;
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
const MUTATION_HEADERS = { 'x-agent-devtools': '1' };

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
 */
export function subscribeToRevisions(onRevision: (rev: number) => void): () => void {
  const source = new EventSource('/api/stream');
  source.addEventListener('rev', (event) => {
    onRevision(Number((event as MessageEvent<string>).data));
  });
  return () => source.close();
}
