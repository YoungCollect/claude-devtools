import { spawn, type ChildProcess } from 'node:child_process';

import { runCommand, type ClaudeClientProfile } from '../core/clients.js';

/**
 * Starting the agent for you, instead of telling you how to start it.
 *
 * `runCommand` has always known the whole answer — which binary, which
 * environment variable, which path under the proxy origin — and every caller
 * did the same thing with it: print it and wait for someone to paste it back.
 * This module executes it. The manual step it removes was also the step where
 * the base URL could be typed wrong or, worse, left pointing at a proxy that
 * had since moved.
 *
 * The client owns the terminal while it runs. That only works because this
 * server is silent after its banner — see `index.ts`, where every remaining
 * write is a fatal error on the way out.
 */

export interface RunningCapture {
  proxyUrl: string;
}

/**
 * Is a Claude DevTools capture already listening on this UI port?
 *
 * Asked before binding anything, so that a second `run` attaches to the first
 * rather than dying on EADDRINUSE. This keeps a second `run` from opening a
 * second SQLite writer and gives both Claude Code sessions one trace UI.
 *
 * `/api/config` answers only for our own kind of process, so an unrelated
 * service holding the port is reported as a conflict rather than attached to.
 */
export async function findRunningCapture(uiPort: number): Promise<RunningCapture | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${uiPort}/api/config`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const proxyUrl = (body as { proxyUrl?: unknown }).proxyUrl;
    return typeof proxyUrl === 'string' ? { proxyUrl } : undefined;
  } catch {
    // Nothing listening, not ours, or too slow to be worth waiting on. Any of
    // those means "start your own", which is the safe answer.
    return undefined;
  }
}

export interface LaunchOptions {
  client: ClaudeClientProfile;
  /** Arguments after `--`, handed to the client untouched. */
  args: readonly string[];
  /** Origin of the capture proxy this client should talk to. */
  proxyUrl: string;
}

export interface LaunchResult {
  code: number | null;
  /** True when the binary could not be started at all, so nothing ever ran. */
  failedToStart: boolean;
}

/**
 * A launched client, and the handle needed to take it down with us.
 *
 * The child is exposed so the signal handler that already owns shutdown can
 * kill it. Installing a second handler here would mean two pieces of code
 * deciding what Ctrl-C does.
 */
export interface Launched {
  child: ChildProcess | undefined;
  exited: Promise<LaunchResult>;
}

export function launchClient({ client, args, proxyUrl }: LaunchOptions): Launched {
  const point = client.pointAt(proxyUrl);
  const handle: Launched = { child: undefined, exited: Promise.resolve({ code: 0, failedToStart: true }) };

  handle.exited = new Promise<LaunchResult>((resolve) => {
    // Redirection first, the user's arguments after: theirs may include a
    // subcommand, and a flag that follows one is that subcommand's to read.
    const child = spawn(client.binary, [...point.args, ...args], {
      // No shell: the arguments arrive already split, and running them through
      // one would make quoting the user's problem and this process's risk.
      env: { ...process.env, ...point.env },
      stdio: 'inherit',
    });
    handle.child = child;

    child.on('error', (error: NodeJS.ErrnoException) => {
      handle.child = undefined;
      if (error.code === 'ENOENT') {
        // The proxy is up and correct; only the convenience failed. Say the
        // thing that still works rather than tearing the capture down.
        console.error(
          `\nclaude-devtools: \`${client.binary}\` was not found on PATH, so ${client.label} was not started.\n` +
            '  The capture is running — start it yourself with:\n\n' +
            `    ${runCommand(proxyUrl)}\n`,
        );
      } else {
        console.error(`\nclaude-devtools: ${client.label} could not be started: ${error.message}\n`);
      }
      resolve({ code: null, failedToStart: true });
    });

    child.on('exit', (code) => {
      handle.child = undefined;
      resolve({ code, failedToStart: false });
    });
  });

  return handle;
}
