import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';

import { Store } from '../core/store.js';
import { TraceBuilder } from '../core/trace-builder.js';
import { createApi } from './api.js';
import { loadConfig } from './config.js';
import { createProxy } from './proxy.js';

const config = loadConfig();
const store = new Store(config.maxRequests);
const builder = new TraceBuilder(store);

createProxy({
  upstream: config.upstream,
  host: config.host,
  port: config.proxyPort,
  hooks: {
    onRequestStart: () => {
      // Nothing to record yet — the body decides which conversation this is.
    },
    onRequestBody: (record) => builder.onRequestBody(record),
    onResponseStart: (record) => {
      store.putTransport(record);
      store.touch();
    },
    onStreamFrames: (record, frames) => builder.onStreamFrames(record, frames),
    onComplete: (record) => builder.onComplete(record),
  },
});

const here = dirname(fileURLToPath(import.meta.url));
// Built layout is dist/server/index.js next to dist/web; in dev Vite serves the UI.
const webRoot = [resolve(here, '../web'), resolve(here, '../../dist/web')].find(existsSync);

serve({
  fetch: createApi({ store, config, webRoot }).fetch,
  hostname: config.host,
  port: config.uiPort,
});

const proxyUrl = `http://${config.host}:${config.proxyPort}`;
const uiUrl = `http://${config.host}:${config.uiPort}`;

console.log(`
  agent-devtools

  proxy     ${proxyUrl}  →  ${config.upstream}
  ui        ${webRoot ? uiUrl : `${uiUrl} (api only — run \`npm run dev:web\` for the UI)`}

  Point an agent at the proxy:

    ANTHROPIC_BASE_URL=${proxyUrl} claude
`);
