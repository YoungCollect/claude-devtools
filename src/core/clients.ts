/**
 * How Claude Code is launched against the local capture proxy.
 *
 * This is client configuration rather than Anthropic wire knowledge: the
 * protocol adapter parses traffic, while this module only prepares a child
 * process. Keeping that distinction lets the launcher and UI share one source
 * of truth without teaching either one about Messages API payloads.
 */
export interface ClaudeClientProfile {
  label: 'Claude Code';
  binary: 'claude';
  pointAt(proxyUrl: string): { env: Record<string, string>; args: string[] };
}

export const CLAUDE_CODE: ClaudeClientProfile = {
  label: 'Claude Code',
  binary: 'claude',
  pointAt: (proxyUrl) => ({ env: { ANTHROPIC_BASE_URL: proxyUrl }, args: [] }),
};

/** The preferred command for launching Claude Code into an existing capture. */
export function runCommand(uiPort = 4142): string {
  return uiPort === 4142 ? 'claude-devtools run' : `claude-devtools run --ui-port ${uiPort}`;
}

/** Direct launch fallback when the convenience CLI itself cannot be used. */
export function manualRunCommand(proxyUrl: string): string {
  return `ANTHROPIC_BASE_URL=${proxyUrl} claude`;
}
