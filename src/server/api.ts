import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { redactHeaders } from '../core/redact.js';
import { assembleStreamResponse, inspectRequest } from '../core/adapters/index.js';
import type { Store } from '../core/store.js';
import type { TransportRecord } from '../core/types.js';
import type { Config } from './config.js';
import type { Persistence } from './persistence.js';

export interface ApiOptions {
  store: Store;
  config: Config;
  /** Absolute path to the built SPA, or undefined in dev (Vite serves it). */
  webRoot?: string;
  /** Storage backing the on-demand body loads. Absent with `--no-persist`. */
  persistence?: Persistence;
  /** Clears memory, reconstruction state, and disk as one lifecycle operation. */
  clearState: () => void;
  /**
   * Dev only: where Vite is serving the UI. Non-API requests are redirected
   * there, so opening the usual port during `pnpm dev` still lands on the UI
   * that hot-reloads instead of a stale bundle or a blank page.
   */
  devUiUrl?: string;
}

export function createApi({
  store,
  config,
  webRoot,
  persistence,
  clearState,
  devUiUrl,
}: ApiOptions): Hono {
  const app = new Hono();

  app.get('/api/config', (c) =>
    c.json({
      proxyUrl: `http://${config.host}:${config.proxyPort}`,
      upstream: config.upstream,
      uiPort: config.uiPort,
    }),
  );

  app.get('/api/state', (c) => c.json(store.snapshot()));

  app.get('/api/conversations/:id/nodes', (c) => {
    const id = c.req.param('id');
    if (!store.getConversation(id)) return c.json({ error: 'not found' }, 404);
    return c.json({ nodes: store.getNodes(id) });
  });

  app.get('/api/transport/:id', (c) => {
    const record = store.getTransport(c.req.param('id'));
    if (!record) return c.json({ error: 'not found' }, 404);
    // Credentials stay masked unless the caller opts in per request — the UI
    // does that behind an explicit "reveal" toggle.
    const reveal = c.req.query('reveal') === '1';
    return c.json({ record: presentRecord(hydrate(record, persistence), reveal) });
  });

  app.post('/api/clear', (c) => {
    clearState();
    return c.json({ ok: true });
  });

  app.get('/api/storage', (c) =>
    c.json(
      persistence
        ? { enabled: true, file: config.dbFile, bytes: persistence.totalBytes(), maxBytes: config.maxBytes }
        : { enabled: false },
    ),
  );

  /**
   * Change feed. Only a revision number goes over the wire; the UI refetches
   * the (small) snapshot when it moves. With one local agent the volume is
   * trivial, and it removes any chance of the UI and the store disagreeing.
   */
  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      let closed = false;
      let pending: NodeJS.Timeout | undefined;
      let lastSent = -1;

      const send = async () => {
        if (closed) return;
        const rev = store.getRev();
        if (rev === lastSent) return;
        lastSent = rev;
        await stream.writeSSE({ event: 'rev', data: String(rev) });
      };

      const unsubscribe = store.subscribe(() => {
        // Coalesce: a streaming turn bumps the revision on every SSE frame.
        if (pending) return;
        pending = setTimeout(() => {
          pending = undefined;
          void send();
        }, 80);
      });

      stream.onAbort(() => {
        closed = true;
        if (pending) clearTimeout(pending);
        unsubscribe();
      });

      await send();
      while (!closed) {
        await stream.sleep(15_000);
        if (!closed) await stream.writeSSE({ event: 'ping', data: '1' });
      }
    }),
  );

  if (devUiUrl) {
    app.get('*', (c) => {
      // Never bounce an /api path back to Vite: Vite proxies /api here, so a
      // path that reached this catch-all would ping-pong until the browser
      // gives up with ERR_TOO_MANY_REDIRECTS.
      if (c.req.path.startsWith('/api')) return c.json({ error: 'unknown api route' }, 404);
      return c.redirect(`${devUiUrl}${c.req.path}`, 302);
    });
  } else if (webRoot) {
    app.get('*', async (c) => {
      const served = await serveStatic(webRoot, c.req.path);
      if (served) return new Response(served.body, { headers: { 'content-type': served.type } });
      // SPA fallback: unknown paths render the app shell, not a 404.
      const index = await readFile(join(webRoot, 'index.html')).catch(() => undefined);
      if (!index) return c.text('UI not built. Run `npm run build`, or use `npm run dev`.', 404);
      return new Response(index, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    });
  }

  return app;
}

/**
 * Refills the bodies that were dropped from memory after the exchange finished.
 *
 * Only the Inspector needs them, and only for the one request being viewed —
 * which is exactly why they are not kept resident. A miss means retention has
 * since evicted the request; the metadata still renders.
 */
function hydrate(record: TransportRecord, persistence: Persistence | undefined): TransportRecord {
  if (!record.bodiesOffloaded || !persistence) return record;
  const bodies = persistence.loadBodies(record.id);
  if (!bodies) return record;
  return { ...record, ...bodies };
}

/** Shapes a record for the wire: masked headers plus derived timing. */
function presentRecord(record: TransportRecord, reveal: boolean) {
  const { startedAt, ttfbAt, firstTokenAt, endedAt } = record.timing;
  return {
    ...record,
    assembledResponse: assembleStreamResponse(record),
    requestInspection: inspectRequest(record),
    requestHeaders: redactHeaders(record.requestHeaders, reveal),
    responseHeaders: record.responseHeaders
      ? redactHeaders(record.responseHeaders, reveal)
      : undefined,
    derivedTiming: {
      totalMs: endedAt !== undefined ? endedAt - startedAt : undefined,
      ttfbMs: ttfbAt !== undefined ? ttfbAt - startedAt : undefined,
      firstTokenMs: firstTokenAt !== undefined ? firstTokenAt - startedAt : undefined,
      streamMs:
        endedAt !== undefined && ttfbAt !== undefined ? endedAt - ttfbAt : undefined,
      frameCount: record.sseFrames.length,
    },
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(
  root: string,
  urlPath: string,
): Promise<{ body: Buffer; type: string } | undefined> {
  // normalize() collapses `..`; the resolve() guard then rejects anything that
  // still escaped the web root.
  const candidate = resolve(root, `.${normalize(urlPath)}`);
  if (!candidate.startsWith(resolve(root))) return undefined;
  const info = await stat(candidate).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const body = await readFile(candidate);
  return { body, type: MIME[extname(candidate)] ?? 'application/octet-stream' };
}
