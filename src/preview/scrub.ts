/**
 * Last line of defence before captured traffic becomes a public web page.
 *
 * Headers are already masked twice over — once on the way into SQLite, once in
 * `presentRecord` — so this is not about headers. It is about bodies: a preview
 * database is built from real Claude Code sessions, and those prompts carry
 * whole source files, `.env` dumps, and shell transcripts that no header rule
 * ever sees. Publishing is irreversible, so a match fails the build rather than
 * warning and continuing.
 *
 * Each pattern demands a long enough run of credential-shaped characters that a
 * `maskSecret` output — which keeps only a 10-character head and a 4-character
 * tail around a bullet run — cannot trip it.
 */

interface CredentialPattern {
  /** Named so a failure can say what was found without printing it. */
  label: string;
  pattern: RegExp;
}

const CREDENTIAL_PATTERNS: CredentialPattern[] = [
  { label: 'Anthropic API key', pattern: /sk-ant-[A-Za-z0-9_-]{24,}/ },
  { label: 'OpenAI API key', pattern: /sk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { label: 'GitHub token', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { label: 'GitHub fine-grained token', pattern: /github_pat_[A-Za-z0-9_]{50,}/ },
  { label: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { label: 'Google API key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/ },
  { label: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}/ },
  { label: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
];

export class CredentialLeakError extends Error {
  constructor(
    readonly label: string,
    readonly where: string,
  ) {
    super(
      `refusing to write ${where}: it contains what looks like a live ${label}.\n` +
        'A preview database is published publicly and cannot be un-published. Remove the\n' +
        'affected conversation from the database (delete it in the UI, then rebuild) or\n' +
        'recapture the session without the credential in scope.',
    );
    this.name = 'CredentialLeakError';
  }
}

/**
 * Throws on the first match. The offending value is deliberately never included
 * in the message: this runs in CI, where the log is as public as the page.
 */
export function assertNoCredentials(json: string, where: string): void {
  const found = findCredential(json);
  if (found) throw new CredentialLeakError(found, where);
}

/** Returns the label of the first credential shape present, if any. */
export function findCredential(text: string): string | undefined {
  for (const { label, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return undefined;
}
