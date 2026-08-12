import { CLAUDE_CODE, type ClaudeClientProfile } from '../core/clients.js';

/** Parsed command-line options for the Claude-only capture. */
export interface CliOptions {
  help?: boolean;
  version?: boolean;
  dev?: boolean;
  persist?: boolean;
  /** Present when `run` should launch Claude Code after both listeners bind. */
  runClient?: ClaudeClientProfile;
  /** Everything after `--`, handed to Claude Code unchanged. */
  runArgs?: string[];
  proxyPort?: number;
  uiPort?: number;
  /** Anthropic-compatible upstream receiving all proxied traffic. */
  upstream?: string;
  dbFile?: string;
  maxBytes?: number;
  maxRequests?: number;
}

export const USAGE = `claude-devtools — local observability for Claude Code

Usage
  claude-devtools [options]              Start the capture
  claude-devtools run [options] [-- <claude args>]
                                          Start the capture and launch Claude Code

Options
  --proxy-url <url>        Where Claude Code sends Anthropic traffic
  --proxy-port <port>      Just the proxy port (default: 4141)
  --ui-port <port>         Port serving the devtools UI and its API (default: 4142)
  --upstream <url>         Anthropic-compatible upstream (default: https://api.anthropic.com)
  --db <path>              SQLite file holding captured traces
  --max-bytes <n>          Stored body bytes kept before the oldest are dropped
  --max-requests <n>       In-memory request index size
  --no-persist             Keep everything in memory; traces are lost on restart
  --dev                    Serve the UI from the Vite dev server
  -h, --help               Print this and exit
  -v, --version            Print the version and exit

Every listener is bound to 127.0.0.1. Captured traffic holds live credentials,
prompts, and source files, so it is never exposed off the loopback interface.
`;

function readLoopbackUrl(flag: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${flag} must be a URL, e.g. http://127.0.0.1:4141`);
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error(
      `${flag} must be on 127.0.0.1; captured traffic cannot be exposed without authentication`,
    );
  }
  if (!url.port) throw new Error(`${flag} must include a port, e.g. http://127.0.0.1:4141`);
  return url;
}

function readPort(flag: string, value: string): number {
  const port = readCount(flag, value);
  if (port > 65_535) throw new Error(`${flag} must be between 1 and 65535`);
  return port;
}

function readCount(flag: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function readUpstream(flag: string, value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http');
    return url.origin + url.pathname.replace(/\/$/, '');
  } catch {
    throw new Error(`${flag} must be an http(s) URL, e.g. https://api.anthropic.com`);
  }
}

/** Parses arguments after the executable and script. */
export function parseArgs(input: readonly string[]): CliOptions {
  let argv = input;
  const options: CliOptions = {};
  const start = argv[0] === '--' ? 1 : 0;

  if (argv[start] === 'run') {
    options.runClient = CLAUDE_CODE;
    const tail = argv.slice(start + 1);
    const separator = tail.indexOf('--');
    if (separator === -1) {
      argv = tail;
      options.runArgs = [];
    } else {
      argv = tail.slice(0, separator);
      options.runArgs = [...tail.slice(separator + 1)];
    }
  }

  const value = (flag: string, index: number): string => {
    const next = argv[index];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || arg === '--') continue;
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    const take = (): string => {
      if (inline !== undefined) {
        if (!inline) throw new Error(`${flag} needs a value`);
        return inline;
      }
      return value(flag, ++i);
    };

    switch (flag) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      case '--dev':
        options.dev = true;
        break;
      case '--no-persist':
        options.persist = false;
        break;
      case '--proxy-url':
        options.proxyPort = Number(readLoopbackUrl(flag, take()).port);
        break;
      case '--proxy-port':
        options.proxyPort = readPort(flag, take());
        break;
      case '--ui-port':
        options.uiPort = readPort(flag, take());
        break;
      case '--upstream':
        options.upstream = readUpstream(flag, take());
        break;
      case '--db':
        options.dbFile = take();
        break;
      case '--max-bytes':
        options.maxBytes = readCount(flag, take());
        break;
      case '--max-requests':
        options.maxRequests = readCount(flag, take());
        break;
      default:
        throw new Error(`unknown option ${flag}\n\n${USAGE}`);
    }
  }
  return options;
}
