import { orderedClients, runCommand } from '../core/clients.js';
import type { KnownProviderId } from '../core/types.js';
import type { ServerConfig } from './api.js';

/** One client, and the single line that points it at this proxy. */
export interface RunCommand {
  provider: KnownProviderId;
  /** The client this line starts, not the provider — that is what you type. */
  label: string;
  command: string;
}

/**
 * How to point each supported client at the capture proxy.
 *
 * One port serves both providers (the route comes from the request path), so
 * these are alternatives you may run at the same time, not a choice between
 * configurations. OpenAI clients want the API root including `/v1`; Anthropic's
 * want the origin.
 */
export function runCommands(config: ServerConfig | undefined): RunCommand[] {
  if (!config) return [];
  return orderedClients(config.defaultProvider).map((client) => ({
    provider: client.provider,
    label: client.label,
    command: runCommand(client, config.proxyUrl),
  }));
}

/**
 * The one command a single control can stand for — the default provider's.
 *
 * The server decides which that is (`--client`), so a session started for Codex
 * offers the Codex line rather than always naming Claude Code.
 */
export function primaryRunCommand(config: ServerConfig | undefined): string {
  // `runCommands` already puts the selected client first.
  return runCommands(config)[0]?.command ?? '';
}
