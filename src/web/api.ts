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

export const api = {
  config: () => getJson<ServerConfig>('/api/config'),
  state: () => getJson<StateSnapshot>('/api/state'),
  nodes: (conversationId: string) =>
    getJson<{ nodes: TraceNode[] }>(`/api/conversations/${conversationId}/nodes`),
  transport: (id: string, reveal: boolean) =>
    getJson<{ record: TransportDetail }>(`/api/transport/${id}${reveal ? '?reveal=1' : ''}`),
  clear: () => fetch('/api/clear', { method: 'POST' }),
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
