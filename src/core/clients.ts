import type { KnownProviderId } from './types.js';

/**
 * The agent clients this proxy knows how to be pointed at.
 *
 * One table, read by three places that must never disagree: the `--client`
 * flag, the banner the server prints, and the command the UI offers to copy.
 * When they were written out separately, the UI kept offering a Claude Code
 * line to a session started for Codex.
 *
 * This is not provider wire knowledge — no request shape, no event names, and
 * nothing here is consulted while parsing traffic. It is how a client is told
 * where its API lives, which is exactly the thing a launcher has to know.
 */
export interface ClientProfile {
  provider: KnownProviderId;
  /** The client, not the vendor: what you actually type. */
  label: string;
  binary: string;
  /** The environment variable the client reads its API root from. */
  baseUrlVar: string;
  /**
   * What that variable must point at, relative to the proxy origin. OpenAI
   * clients want the versioned API root; Anthropic's want the origin.
   */
  basePath: string;
  /** Names `--client` accepts for this profile. */
  aliases: string[];
}

export const CLIENTS: readonly ClientProfile[] = [
  {
    provider: 'anthropic',
    label: 'Claude Code',
    binary: 'claude',
    baseUrlVar: 'ANTHROPIC_BASE_URL',
    basePath: '',
    aliases: ['claude', 'claude-code', 'anthropic'],
  },
  {
    provider: 'openai',
    label: 'Codex',
    binary: 'codex',
    baseUrlVar: 'OPENAI_BASE_URL',
    basePath: '/v1',
    aliases: ['codex', 'openai'],
  },
];

export function clientForProvider(provider: KnownProviderId): ClientProfile | undefined {
  return CLIENTS.find((client) => client.provider === provider);
}

export function clientForAlias(name: string): ClientProfile | undefined {
  const lower = name.toLowerCase();
  return CLIENTS.find((client) => client.aliases.includes(lower));
}

/** Every alias `--client` accepts, for the usage text and its error message. */
export function clientAliases(): string[] {
  return CLIENTS.flatMap((client) => client.aliases);
}

/** The one line that points this client at the proxy. */
export function runCommand(client: ClientProfile, proxyUrl: string): string {
  return `${client.baseUrlVar}=${proxyUrl}${client.basePath} ${client.binary}`;
}

/**
 * Every client, the selected one first.
 *
 * All of them are listed whichever was selected: the proxy routes by request
 * path, so running one client never rules out another, and hiding the rest
 * would describe a restriction that does not exist.
 */
export function orderedClients(preferred: KnownProviderId | undefined): ClientProfile[] {
  return [...CLIENTS].sort((a, b) =>
    a.provider === preferred ? -1 : b.provider === preferred ? 1 : 0,
  );
}
