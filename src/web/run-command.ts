import { runCommand } from '../core/clients.js';
import type { ServerConfig } from './api.js';

export interface RunCommand {
  label: 'Claude Code';
  command: string;
}

export function runCommands(config: ServerConfig | undefined): RunCommand[] {
  return config ? [{ label: 'Claude Code', command: runCommand(config.uiPort) }] : [];
}

export function primaryRunCommand(config: ServerConfig | undefined): string {
  return config ? runCommand(config.uiPort) : '';
}
