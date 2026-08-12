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

/** The shell command shown when the capture was started without `run`. */
export function runCommand(proxyUrl: string): string {
  return `ANTHROPIC_BASE_URL=${proxyUrl} claude`;
}
