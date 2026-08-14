import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';

import { runCommand } from '../core/clients.js';
import { Store } from '../core/store.js';
import { TraceBuilder } from '../core/trace-builder.js';
import { createApi } from './api.js';
import { parseArgs, USAGE } from './cli.js';
import { loadConfig } from './config.js';
import { openInBrowser, shouldOpenUi } from './open-browser.js';
import { Persistence } from './persistence.js';
import { createProxy } from './proxy.js';
import { findRunningCapture, launchClient, type Launched } from './run-client.js';
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
    console.error(`claude-devtools: ${error instanceof Error ? error.message : String(error)}`);
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

/**
 * A second `run` joins the first capture instead of starting a rival.
 *
 * Checked before anything is opened — the database especially, since two
 * processes writing one SQLite file is the kind of damage a convenience feature
 * has no business risking. Attaching means this process owns nothing but the
 * child: no listeners, no storage, and no banner, because the capture it is
 * joining already printed one.
 */
if (cli.runClient) {
  const existing = await findRunningCapture(config.uiPort);
  if (existing) {
    // No browser here on purpose: the capture being joined opened one already,
    // and every session lands in that same UI, so a second `run` would only add
    // a duplicate tab of a page that is already live. The URL is printed
    // instead, for the case where that tab was since closed.
    console.log(
      `\n  claude-devtools  ·  joining the capture already on ${existing.proxyUrl}\n` +
        `  ui        http://${config.host}:${config.uiPort}\n` +
        `  starting ${cli.runClient.label}\n`,
    );
    const attached = launchClient({
      client: cli.runClient,
      args: cli.runArgs ?? [],
      proxyUrl: existing.proxyUrl,
    });
    const result = await attached.exited;
    process.exit(result.failedToStart ? 1 : (result.code ?? 0));
  }
}

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
  upstream: config.upstream,
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
/** Where a human reads the trace: Vite owns the page in dev, the API serves it otherwise. */
const uiUrl = devMode ? viteUrl : apiUrl;

/**
 * The banner waits for both listeners.
 *
 * It names the ports this process is serving on, so printing it before they are
 * bound turns the one failure a user hits routinely — the port is already taken
 * by another capture — into a startup that reports success and then throws a
 * stack trace underneath it.
 */
let pendingListeners = 2;
/** The client this process launched, if any — held so shutdown can take it with us. */
let launched: Launched | undefined;

const announceWhenReady = () => {
  if (--pendingListeners > 0) return;
  console.log(banner());
  if (!cli.runClient) return;

  // Before the client, not after: this is the last thing written to this
  // terminal, and handing it over to Claude Code while a browser is still being
  // spawned would interleave an opener failure with the client's first frame.
  if (
    shouldOpenUi({
      requested: cli.open !== false,
      uiIsServed: devMode || webRoot !== undefined,
      env: process.env,
      platform: process.platform,
    })
  ) {
    openInBrowser(uiUrl);
  }

  // Started only once both ports are bound: a client that came up first would
  // send its opening request to a proxy that was not listening yet.
  launched = launchClient({
    client: cli.runClient,
    args: cli.runArgs ?? [],
    proxyUrl,
  });
  void launched.exited.then((result) => {
    // The capture outlives the client on purpose — reading the trace is what
    // you do *after* the session ends. Ctrl-C is the way out, and it takes the
    // whole thing down through the handler below.
    if (result.failedToStart) return;
    console.log(
      `\n  ${cli.runClient?.label} exited. The capture is still running:\n` +
        `  ui        ${uiUrl}\n` +
        '  Ctrl-C to stop.\n',
    );
  });
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
      `claude-devtools: the ${what} could not start — 127.0.0.1:${port} is already in use.\n` +
        '  Another capture is probably running. Stop it, or choose other ports with' +
        ' --proxy-port / --ui-port.',
    );
  } else {
    console.error(`claude-devtools: the ${what} could not start on port ${port}: ${error.message}`);
  }
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // A client started by `run` shares this terminal's process group, so it has
    // already been signalled; this is for the case where it has not, so that
    // quitting the capture never leaves an agent behind holding a base URL that
    // no longer answers.
    launched?.child?.kill(signal);
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

  const nextStep = cli.runClient
    ? `  Starting ${cli.runClient.label}.\n`
    : `  Start Claude Code through this capture:\n\n    ${runCommand(config.uiPort)}`;

  return `
  claude-devtools${devMode ? '  ·  dev' : ''}

  proxy     ${proxyUrl}
  upstream  ${config.upstream}
  ui        ${uiLine}
  storage   ${storageLine}

${nextStep}
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
