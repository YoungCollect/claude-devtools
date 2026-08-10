import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { SseParser } from '../core/sse.js';
import type { SseFrame, TransportRecord } from '../core/types.js';

/**
 * Hop-by-hop headers must not be forwarded — Node manages framing itself, and
 * passing `transfer-encoding` through corrupts the response.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

export interface ProxyHooks {
  /** Request line + headers seen; body not yet complete. */
  onRequestStart(record: TransportRecord): void;
  /** Request body fully received and parsed. */
  onRequestBody(record: TransportRecord): void;
  /** Upstream response headers received. */
  onResponseStart(record: TransportRecord): void;
  /** One or more SSE frames forwarded to the client. */
  onStreamFrames(record: TransportRecord, frames: SseFrame[]): void;
  /** Exchange finished (or failed — check `record.error`). */
  onComplete(record: TransportRecord): void;
}

export interface ProxyOptions {
  upstream: string;
  host: string;
  port: number;
  hooks: ProxyHooks;
}

export function createProxy(options: ProxyOptions): http.Server {
  const upstreamUrl = new URL(options.upstream);
  const isTls = upstreamUrl.protocol === 'https:';
  const transport = isTls ? https : http;
  // Keep-alive matters: Claude Code fires many requests per turn and a fresh
  // TLS handshake each time would show up as latency we invented ourselves.
  const agent = new transport.Agent({ keepAlive: true, maxSockets: 64 });

  const server = http.createServer((req, res) => {
    req.socket.setNoDelay(true);

    const record: TransportRecord = {
      id: randomUUID(),
      provider: 'unknown',
      kind: 'other',
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      url: new URL(req.url ?? '/', upstreamUrl).toString(),
      requestHeaders: flattenHeaders(req.headers),
      isStream: false,
      sseFrames: [],
      timing: { startedAt: Date.now() },
      requestBytes: 0,
      responseBytes: 0,
    };
    options.hooks.onRequestStart(record);

    const upstreamPath = joinPath(upstreamUrl.pathname, req.url ?? '/');
    const upstreamReq = transport.request(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isTls ? 443 : 80),
        method: req.method,
        path: upstreamPath,
        headers: buildUpstreamHeaders(req.headers, upstreamUrl.host),
        agent,
      },
      (upstreamRes) => {
        upstreamRes.socket?.setNoDelay(true);
        record.timing.ttfbAt = Date.now();
        record.status = upstreamRes.statusCode;
        record.statusText = upstreamRes.statusMessage;
        record.responseHeaders = flattenHeaders(upstreamRes.headers);
        record.isStream = (upstreamRes.headers['content-type'] ?? '').includes('text/event-stream');
        options.hooks.onResponseStart(record);

        res.writeHead(upstreamRes.statusCode ?? 502, filterHeaders(upstreamRes.headers));
        res.flushHeaders();

        const parser = record.isStream ? new SseParser() : undefined;
        const bodyChunks: Buffer[] = [];

        upstreamRes.on('data', (chunk: Buffer) => {
          // Forward first, record second. The agent's stream must never wait on
          // our bookkeeping — a stuttering Claude Code is an abandoned devtool.
          res.write(chunk);
          record.responseBytes += chunk.length;

          if (parser) {
            const now = Date.now();
            // Bytes, not `chunk.toString()`: the parser decodes across chunk
            // boundaries so a multi-byte character split by the network is not
            // destroyed on the way into the capture.
            const frames = parser.pushBytes(chunk, now);
            if (frames.length > 0) {
              record.sseFrames.push(...frames);
              options.hooks.onStreamFrames(record, frames);
            }
          } else {
            bodyChunks.push(chunk);
          }
        });

        upstreamRes.on('end', () => {
          const now = Date.now();
          if (parser) {
            const tail = parser.end(now);
            if (tail.length > 0) record.sseFrames.push(...tail);
          } else if (bodyChunks.length > 0) {
            const text = Buffer.concat(bodyChunks).toString('utf8');
            record.responseBodyRaw = text;
            record.responseBody = tryParseJson(text);
          }
          record.timing.endedAt = now;
          res.end();
          options.hooks.onComplete(record);
        });

        upstreamRes.on('error', (error: Error) => {
          record.error = `upstream response: ${error.message}`;
          record.timing.endedAt = Date.now();
          res.end();
          options.hooks.onComplete(record);
        });
      },
    );

    upstreamReq.on('error', (error: Error) => {
      record.error = `upstream request: ${error.message}`;
      record.timing.endedAt = Date.now();
      if (res.headersSent) {
        // The agent is already reading a response — very likely an open SSE
        // stream. Appending a JSON error object to it would hand the client a
        // malformed frame on top of whatever went wrong upstream, so the
        // connection just ends and the failure lives on the record instead.
        res.end();
      } else {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: { type: 'agent_devtools_proxy_error', message: error.message } }),
        );
      }
      options.hooks.onComplete(record);
    });

    // Tee the request body: pipe carries it upstream unbuffered while a second
    // listener collects a copy for the inspector.
    const requestChunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      requestChunks.push(chunk);
      record.requestBytes += chunk.length;
    });
    req.on('end', () => {
      if (requestChunks.length > 0) {
        const text = Buffer.concat(requestChunks).toString('utf8');
        record.requestBodyRaw = text;
        record.requestBody = tryParseJson(text);
      }
      options.hooks.onRequestBody(record);
    });
    req.on('error', () => upstreamReq.destroy());
    res.on('close', () => {
      if (record.timing.endedAt === undefined) {
        // The agent hung up mid-stream (Esc in Claude Code). Record it as a
        // real outcome rather than leaving the request pending forever.
        record.error = record.error ?? 'client aborted';
        record.timing.endedAt = Date.now();
        upstreamReq.destroy();
        options.hooks.onComplete(record);
      }
    });

    req.pipe(upstreamReq);
  });

  server.listen(options.port, options.host);
  return server;
}

export function serverPort(server: http.Server): number {
  const address = server.address() as AddressInfo | null;
  return address?.port ?? 0;
}

function buildUpstreamHeaders(
  headers: http.IncomingHttpHeaders,
  upstreamHost: string,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  out.host = upstreamHost;
  // Compressed bodies would have to be inflated before they could be inspected.
  // For a loopback devtool the bandwidth is free and identity keeps Raw honest.
  out['accept-encoding'] = 'identity';
  return out;
}

function filterHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/** `https://host/base` + `/v1/messages` → `/base/v1/messages`. */
function joinPath(basePath: string, requestPath: string): string {
  const base = basePath.replace(/\/$/, '');
  if (!base) return requestPath;
  return `${base}${requestPath}`;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
