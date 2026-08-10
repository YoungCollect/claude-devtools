import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

/**
 * In dev the UI is served by Vite (HMR), not by us. Passed as an argument
 * rather than an env var so the dev script stays shell-agnostic.
 */
const devMode = process.argv.includes('--dev');

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Built layout is dist/server/index.js next to dist/web.
 *
 * The `assets/` check matters: running from source puts `here` at src/server,
 * where `../web` is the *source* directory. It exists, so a plain existsSync
 * would happily serve raw .tsx files. Only a built bundle has `assets/`.
 */
const webRoot = devMode
  ? undefined
  : [resolve(here, '../web'), resolve(here, '../../dist/web')].find((dir) =>
      existsSync(join(dir, 'assets')),
    );

const proxyUrl = `http://${config.host}:${config.proxyPort}`;
const apiUrl = `http://${config.host}:${config.uiPort}`;
const viteUrl = `http://${config.host}:${config.vitePort}`;

serve({
  // Whichever port you open in dev, you land on the UI that actually hot-reloads.
  fetch: createApi({ store, config, webRoot, devUiUrl: devMode ? viteUrl : undefined }).fetch,
  hostname: config.host,
  port: config.uiPort,
});

const uiLine = devMode
  ? `${viteUrl}  (vite · hot reload — ${apiUrl} redirects here)`
  : webRoot
    ? apiUrl
    : `${apiUrl}  (api only — UI not built; run \`pnpm build\`, or \`pnpm dev\` for hot reload)`;

console.log(`
  agent-devtools${devMode ? '  ·  dev' : ''}

  proxy     ${proxyUrl}  →  ${config.upstream}
  ui        ${uiLine}

  Point an agent at the proxy:

    ANTHROPIC_BASE_URL=${proxyUrl} claude
`);
