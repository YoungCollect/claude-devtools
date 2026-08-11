import { homedir } from 'node:os';
import { join } from 'node:path';

import type { KnownProviderId } from '../core/types.js';
import { parseArgs } from './cli.js';

/** Providers this proxy can forward to. Adding one is a route plus an adapter. */
export const PROVIDERS = ['anthropic', 'openai'] as const satisfies readonly KnownProviderId[];

export interface Config {
  /** Port every client points its base URL at, whichever provider it speaks. */
  proxyPort: number;
  /** Port serving the devtools UI and its API. */
  uiPort: number;
  /** Where the Vite dev server runs. Must match vite.config.ts (strictPort). */
  vitePort: number;
  /**
   * Where each provider's traffic is forwarded.
   *
   * One listening port, one upstream per provider: the route is chosen per
   * request from the path the client asked for (see `resolveUpstream`), so a
   * Claude Code session and a Codex session can share this proxy without either
   * knowing the other is there.
   */
  upstreams: Record<KnownProviderId, string>;
  /** Where traffic belonging to no known provider goes — auth, models, probes. */
  defaultProvider: KnownProviderId;
  /** Loopback only. This tool holds credentials and source code in memory. */
  host: string;
  /** In-memory index size. Bodies live on disk, so this bounds metadata only. */
  maxRequests: number;
  /** Persist traces to disk. Disable with `--no-persist`. */
  persist: boolean;
  dbFile: string;
  /** Stored body bytes retained before the oldest conversations are dropped. */
  maxBytes: number;
}

const DEFAULT_UPSTREAMS: Record<KnownProviderId, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

function intFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be between 1 and ${max}`);
  }
  return parsed;
}

/**
 * The runtime settings, from the command line first and the environment second.
 *
 * `argv` is what follows the executable and script — `process.argv.slice(2)` —
 * so the caller decides what counts as an argument and this stays trivially
 * testable. Flags win over environment variables because they are the more
 * specific statement: the env describes a machine, the flag describes this run.
 */
export function loadConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const cli = parseArgs(argv);
  const requestedHost = env.AGENT_DEVTOOLS_HOST ?? '127.0.0.1';
  if (requestedHost !== '127.0.0.1') {
    throw new Error(
      'AGENT_DEVTOOLS_HOST must be 127.0.0.1; captured traffic cannot be exposed without authentication',
    );
  }
  return {
    proxyPort: cli.proxyPort ?? intFromEnv(env, 'AGENT_DEVTOOLS_PROXY_PORT', 4141, 65_535),
    uiPort: cli.uiPort ?? intFromEnv(env, 'AGENT_DEVTOOLS_UI_PORT', 4142, 65_535),
    vitePort: intFromEnv(env, 'AGENT_DEVTOOLS_VITE_PORT', 5173, 65_535),
    upstreams: {
      // `AGENT_DEVTOOLS_UPSTREAM` predates multi-provider support and meant
      // "the upstream", which was Anthropic's. It keeps that meaning.
      anthropic:
        cli.upstreams?.anthropic ??
        env.AGENT_DEVTOOLS_ANTHROPIC_UPSTREAM ??
        env.AGENT_DEVTOOLS_UPSTREAM ??
        DEFAULT_UPSTREAMS.anthropic,
      openai:
        cli.upstreams?.openai ?? env.AGENT_DEVTOOLS_OPENAI_UPSTREAM ?? DEFAULT_UPSTREAMS.openai,
    },
    defaultProvider: cli.client ?? 'anthropic',
    host: requestedHost,
    maxRequests: cli.maxRequests ?? intFromEnv(env, 'AGENT_DEVTOOLS_MAX_REQUESTS', 5000),
    persist: cli.persist ?? true,
    dbFile: cli.dbFile ?? env.AGENT_DEVTOOLS_DB ?? join(homedir(), '.agent-devtools', 'traces.db'),
    maxBytes: cli.maxBytes ?? intFromEnv(env, 'AGENT_DEVTOOLS_MAX_BYTES', 1024 * 1024 * 1024),
  };
}
