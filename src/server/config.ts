import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseArgs } from './cli.js';

export interface Config {
  /** Port Claude Code points ANTHROPIC_BASE_URL at. */
  proxyPort: number;
  /** Port serving the devtools UI and its local API. */
  uiPort: number;
  /** Where the Vite dev server runs. Must match vite.config.ts (strictPort). */
  vitePort: number;
  /** Anthropic-compatible destination for every request accepted by the proxy. */
  upstream: string;
  /** Loopback only. This tool holds credentials and source code in memory. */
  host: '127.0.0.1';
  maxRequests: number;
  persist: boolean;
  dbFile: string;
  maxBytes: number;
}

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

function upstreamFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.CLAUDE_DEVTOOLS_UPSTREAM;
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http');
    return url.origin + url.pathname.replace(/\/$/, '');
  } catch {
    throw new Error(
      'CLAUDE_DEVTOOLS_UPSTREAM must be an http(s) URL, e.g. https://api.anthropic.com',
    );
  }
}

export function loadConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const cli = parseArgs(argv);
  const requestedHost = env.CLAUDE_DEVTOOLS_HOST ?? '127.0.0.1';
  if (requestedHost !== '127.0.0.1') {
    throw new Error(
      'CLAUDE_DEVTOOLS_HOST must be 127.0.0.1; captured traffic cannot be exposed without authentication',
    );
  }

  return {
    proxyPort: cli.proxyPort ?? intFromEnv(env, 'CLAUDE_DEVTOOLS_PROXY_PORT', 4141, 65_535),
    uiPort: cli.uiPort ?? intFromEnv(env, 'CLAUDE_DEVTOOLS_UI_PORT', 4142, 65_535),
    vitePort: intFromEnv(env, 'CLAUDE_DEVTOOLS_VITE_PORT', 5173, 65_535),
    upstream: cli.upstream ?? upstreamFromEnv(env) ?? 'https://api.anthropic.com',
    host: requestedHost,
    maxRequests: cli.maxRequests ?? intFromEnv(env, 'CLAUDE_DEVTOOLS_MAX_REQUESTS', 5000),
    persist: cli.persist ?? true,
    dbFile:
      cli.dbFile ?? env.CLAUDE_DEVTOOLS_DB ?? join(homedir(), '.claude-devtools', 'traces.db'),
    maxBytes:
      cli.maxBytes ?? intFromEnv(env, 'CLAUDE_DEVTOOLS_MAX_BYTES', 1024 * 1024 * 1024),
  };
}
