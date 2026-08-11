import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';

import { providerForPath } from '../core/adapters/index.js';
import { orderedClients, runCommand } from '../core/clients.js';
import { Store } from '../core/store.js';
import { TraceBuilder } from '../core/trace-builder.js';
import { createApi } from './api.js';
import { parseArgs, USAGE } from './cli.js';
import { loadConfig, PROVIDERS } from './config.js';
import { Persistence } from './persistence.js';
import { createProxy } from './proxy.js';
import { CaptureRuntime } from './runtime.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A bad flag is a user error, not a crash.
 *
 * Everything below this point assumes a valid configuration, so the two places
 * that can reject one — the command line and the environment — report in one
 * line and exit rather than unwinding a stack trace over the banner.
 */
function orExit<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    console.error(`agent-devtools: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const argv = process.argv.slice(2);
const cli = orExit(() => parseArgs(argv));

if (cli.help) {
  console.log(USAGE);
  process.exit(0);
}
if (cli.version) {
  console.log(readVersion());
  process.exit(0);
}

const config = orExit(() => loadConfig(argv));
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

const proxy = createProxy({
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
const devMode = cli.dev === true;

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

/**
 * The banner waits for both listeners.
 *
 * It names the ports this process is serving on, so printing it before they are
 * bound turns the one failure a user hits routinely — the port is already taken
 * by another capture — into a startup that reports success and then throws a
 * stack trace underneath it.
 */
let pendingListeners = 2;
const announceWhenReady = () => {
  if (--pendingListeners === 0) console.log(banner());
};

proxy.once('listening', announceWhenReady);
proxy.on('error', (error) => exitOnListenError('capture proxy', config.proxyPort, error));

const ui = serve(
  {
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
  },
  announceWhenReady,
);

ui.on('error', (error: NodeJS.ErrnoException) =>
  exitOnListenError('devtools UI', config.uiPort, error),
);

/** A port conflict is a thing to say in one line, not to throw a stack over. */
function exitOnListenError(what: string, port: number, error: NodeJS.ErrnoException): never {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `agent-devtools: the ${what} could not start — 127.0.0.1:${port} is already in use.\n` +
        '  Another capture is probably running. Stop it, or choose other ports with' +
        ' --proxy-port / --ui-port.',
    );
  } else {
    console.error(`agent-devtools: the ${what} could not start on port ${port}: ${error.message}`);
  }
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    persistence?.close();
    process.exit(0);
  });
}

/** What this process is serving, printed once both listeners are bound. */
function banner(): string {
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
   * so both are printed, and the traffic is separated by path, not by port. The
   * `--client` choice only decides which goes first and where unrouted paths go.
   */
  const upstreamLines = PROVIDERS.map(
    (provider) =>
      `            ${provider.padEnd(10)} →  ${config.upstreams[provider]}` +
      `${provider === config.defaultProvider ? '   (default route)' : ''}`,
  ).join('\n');

  const clientLines = orderedClients(config.defaultProvider)
    .map((client) => `    ${runCommand(client, proxyUrl)}`)
    .join('\n');

  return `
  agent-devtools${devMode ? '  ·  dev' : ''}

  proxy     ${proxyUrl}
${upstreamLines}
  ui        ${uiLine}
  storage   ${storageLine}

  Point an agent at the proxy:

${clientLines}
`;
}

/** The published version, for `--version`. Built output sits two levels down. */
function readVersion(): string {
  for (const candidate of ['../../package.json', '../../../package.json']) {
    try {
      const raw = readFileSync(resolve(here, candidate), 'utf8');
      const version = (JSON.parse(raw) as { version?: unknown }).version;
      if (typeof version === 'string') return version;
    } catch {
      // Try the next layout; a missing package.json is not worth failing over.
    }
  }
  return 'unknown';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
