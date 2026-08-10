export interface Config {
  /** Port the agent points `ANTHROPIC_BASE_URL` at. */
  proxyPort: number;
  /** Port serving the devtools UI and its API. */
  uiPort: number;
  /** Where intercepted traffic is forwarded. */
  upstream: string;
  /** Loopback only. This tool holds credentials and source code in memory. */
  host: string;
  maxRequests: number;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): Config {
  return {
    proxyPort: intFromEnv('AGENT_DEVTOOLS_PROXY_PORT', 4141),
    uiPort: intFromEnv('AGENT_DEVTOOLS_UI_PORT', 4142),
    upstream: process.env.AGENT_DEVTOOLS_UPSTREAM ?? 'https://api.anthropic.com',
    host: process.env.AGENT_DEVTOOLS_HOST ?? '127.0.0.1',
    maxRequests: intFromEnv('AGENT_DEVTOOLS_MAX_REQUESTS', 1000),
  };
}
