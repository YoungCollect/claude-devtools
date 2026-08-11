import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';

import { providerForPath } from '../core/adapters/index.js';
import { Store } from '../core/store.js';
import { TraceBuilder } from '../core/trace-builder.js';
import { createApi } from './api.js';
import { loadConfig, PROVIDERS } from './config.js';
import { Persistence } from './persistence.js';
import { createProxy } from './proxy.js';
import { CaptureRuntime } from './runtime.js';

const config = loadConfig();
const store = new Store(config.maxRequests);
const builder = new TraceBuilder(store);

const persistence = config.persist
  ? new Persistence({ file: config.dbFile, maxBytes: config.maxBytes })
  : undefined;

let restored = { conversations: 0, requests: 0 };
if (persistence) {
  const loaded = persistence.loadAll();
  for (const { conversation } of loaded.conversations) store.putConversation(conversation);
  for (const node of loaded.nodes) store.appendNode(node);
  for (const record of loaded.transport) {
    record.bodiesOffloaded = true;
    store.putTransport(record);
  }
  builder.restore(loaded.conversations, loaded.nodes);
  restored = { conversations: loaded.conversations.length, requests: loaded.transport.length };
  // appendNode() increments nodeCount as a side effect, so replaying a restored
  // conversation's nodes would double it. Recompute from what actually landed.
  for (const { conversation } of loaded.conversations) {
    conversation.nodeCount = store.getNodes(conversation.id).length;
  }
}

const runtime = new CaptureRuntime({
  store,
  builder,
  persistence,
  // Without a database the same byte budget bounds what stays resident.
  maxResidentBodyBytes: config.maxBytes,
});

createProxy({
  // One listener, one upstream per provider. A path no adapter claims — token
  // refresh, `/v1/models`, a health probe — has nothing in it to route on, so
  // it goes to the default rather than being rejected: those calls are part of
  // a real session and dropping them would break the client that made them.
  resolveUpstream: (path) => config.upstreams[providerForPath(path) ?? config.defaultProvider],
  host: config.host,
  port: config.proxyPort,
  hooks: runtime.hooks,
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
  fetch: createApi({
    store,
    config,
    webRoot,
    persistence,
    clearState: () => runtime.clear(),
    deleteConversation: (id) => runtime.deleteConversation(id),
    renameConversation: (id, title) => runtime.renameConversation(id, title),
    devUiUrl: devMode ? viteUrl : undefined,
  }).fetch,
  hostname: config.host,
  port: config.uiPort,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    persistence?.close();
    process.exit(0);
  });
}

const uiLine = devMode
  ? `${viteUrl}  (vite · hot reload — ${apiUrl} redirects here)`
  : webRoot
    ? apiUrl
    : `${apiUrl}  (api only — UI not built; run \`pnpm build\`, or \`pnpm dev\` for hot reload)`;

const storageLine = persistence
  ? `${config.dbFile}  (${formatBytes(persistence.totalBytes())} of ${formatBytes(config.maxBytes)}` +
    `${restored.conversations > 0 ? `, restored ${restored.conversations} conversations / ${restored.requests} requests` : ''})`
  : `off (--no-persist) — bodies stay in memory under ${formatBytes(config.maxBytes)}, lost on restart`;

/**
 * Both providers, on the one port. Which line you need depends on the client
 * you are about to start, and nothing about running one rules out the other —
 * so both are printed, and the traffic is separated by path, not by port.
 */
const upstreamLines = PROVIDERS.map(
  (provider) => `            ${provider.padEnd(10)} →  ${config.upstreams[provider]}`,
).join('\n');

console.log(`
  agent-devtools${devMode ? '  ·  dev' : ''}

  proxy     ${proxyUrl}
${upstreamLines}
  ui        ${uiLine}
  storage   ${storageLine}

  Point an agent at the proxy:

    ANTHROPIC_BASE_URL=${proxyUrl} claude
    OPENAI_BASE_URL=${proxyUrl}/v1 codex
`);

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
