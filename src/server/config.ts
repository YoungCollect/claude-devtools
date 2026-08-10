import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  /** Port the agent points `ANTHROPIC_BASE_URL` at. */
  proxyPort: number;
  /** Port serving the devtools UI and its API. */
  uiPort: number;
  /** Where the Vite dev server runs. Must match vite.config.ts (strictPort). */
  vitePort: number;
  /** Where intercepted traffic is forwarded. */
  upstream: string;
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

export function loadConfig(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const requestedHost = env.AGENT_DEVTOOLS_HOST ?? '127.0.0.1';
  if (requestedHost !== '127.0.0.1') {
    throw new Error(
      'AGENT_DEVTOOLS_HOST must be 127.0.0.1; captured traffic cannot be exposed without authentication',
    );
  }
  return {
    proxyPort: intFromEnv(env, 'AGENT_DEVTOOLS_PROXY_PORT', 4141, 65_535),
    uiPort: intFromEnv(env, 'AGENT_DEVTOOLS_UI_PORT', 4142, 65_535),
    vitePort: intFromEnv(env, 'AGENT_DEVTOOLS_VITE_PORT', 5173, 65_535),
    upstream: env.AGENT_DEVTOOLS_UPSTREAM ?? 'https://api.anthropic.com',
    host: requestedHost,
    maxRequests: intFromEnv(env, 'AGENT_DEVTOOLS_MAX_REQUESTS', 5000),
    persist: !argv.includes('--no-persist'),
    dbFile: env.AGENT_DEVTOOLS_DB ?? join(homedir(), '.agent-devtools', 'traces.db'),
    maxBytes: intFromEnv(env, 'AGENT_DEVTOOLS_MAX_BYTES', 1024 * 1024 * 1024),
  };
}
