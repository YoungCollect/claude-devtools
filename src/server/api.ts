import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { redactHeaders } from '../core/redact.js';
import type { Store } from '../core/store.js';
import type { TransportRecord } from '../core/types.js';
import type { Config } from './config.js';

export interface ApiOptions {
  store: Store;
  config: Config;
  /** Absolute path to the built SPA, or undefined in dev (Vite serves it). */
  webRoot?: string;
}

export function createApi({ store, config, webRoot }: ApiOptions): Hono {
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
    return c.json({ record: presentRecord(record, reveal) });
  });

  app.post('/api/clear', (c) => {
    store.clear();
    return c.json({ ok: true });
  });

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

  if (webRoot) {
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

/** Shapes a record for the wire: masked headers plus derived timing. */
function presentRecord(record: TransportRecord, reveal: boolean) {
  const { startedAt, ttfbAt, firstTokenAt, endedAt } = record.timing;
  return {
    ...record,
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
