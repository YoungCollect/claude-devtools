import { clientAliases, clientForAlias } from '../core/clients.js';
import type { KnownProviderId } from '../core/types.js';

/**
 * `agent-devtools`' own command line.
 *
 * Starting a capture used to mean exporting the right base URL by hand:
 * `ANTHROPIC_BASE_URL=http://127.0.0.1:4141 claude`. That is fine when there is
 * one provider and one default port, and it stops being fine the moment either
 * varies — the string names a port this process chose, so the process is where
 * it belongs. Every setting is a flag here, and the banner prints the exact line
 * to paste for whichever client the session was started for.
 *
 * Flags beat environment variables, which beat defaults. Anything unrecognised
 * is an error rather than a shrug: a mistyped flag that is silently ignored is a
 * capture that quietly does something other than what was asked.
 */
export interface CliOptions {
  help?: boolean;
  version?: boolean;
  /** Serve the UI from Vite instead of the built bundle. */
  dev?: boolean;
  persist?: boolean;
  /**
   * The client this session is for. Both providers stay routable either way —
   * this picks the default for paths that name no provider, and the run command
   * the banner and the UI put forward.
   */
  client?: KnownProviderId;
  proxyPort?: number;
  uiPort?: number;
  upstreams?: Partial<Record<KnownProviderId, string>>;
  dbFile?: string;
  maxBytes?: number;
  maxRequests?: number;
}

export const USAGE = `agent-devtools — a local observability proxy for AI-agent traffic

Usage
  agent-devtools [options]

Options
  --client <name>          Client this session is for: claude | codex
                           (aliases: claude-code, anthropic, openai). Default: claude.
                           Both providers are captured regardless; this selects the
                           default route for paths that name none.
  --proxy-url <url>        Where the capture proxy listens, e.g. http://127.0.0.1:4141
  --proxy-port <port>      Just the port, when the host is not in question
  --ui-port <port>         Port serving the devtools UI and its API
  --upstream <url>         Upstream for --client's provider
  --anthropic-upstream <url>
  --openai-upstream <url>  Upstream for one provider, whatever --client says
  --db <path>              SQLite file holding captured traces
  --max-bytes <n>          Stored body bytes kept before the oldest are dropped
  --max-requests <n>       In-memory request index size
  --no-persist             Keep everything in memory; traces are lost on restart
  --dev                    Serve the UI from the Vite dev server
  -h, --help               Print this and exit
  -v, --version            Print the version and exit

Every listener is bound to 127.0.0.1. Captured traffic holds live credentials and
whole source files, so it is never exposed off the loopback interface.
`;

/**
 * The loopback rule, enforced where a host can first be named.
 *
 * `localhost` is accepted and normalised: it is what people type, and on a
 * machine where it resolves to `::1` a proxy bound to it would be unreachable
 * from every other port in this tool.
 */
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
    // Normalised to an origin: the proxy joins the request path onto this, and
    // a stray trailing slash would send every request to `//v1/messages`.
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('not http');
    }
    return url.origin + url.pathname.replace(/\/$/, '');
  } catch {
    throw new Error(`${flag} must be an http(s) URL, e.g. https://api.openai.com`);
  }
}

/** Parses the arguments after the executable and script — `process.argv.slice(2)`. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {};
  const upstreams: Partial<Record<KnownProviderId, string>> = {};
  /** `--upstream` means "for the selected client", which may be named later. */
  let clientUpstream: string | undefined;

  const value = (flag: string, index: number): string => {
    const next = argv[index];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    // `--flag=value` and `--flag value` are both common enough that supporting
    // only one of them is a papercut every user hits once.
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
      // The conventional end-of-options marker. npm strips it before the script
      // sees it and pnpm does not, so `pnpm start -- --client codex` would
      // otherwise fail on a separator the user was told to type.
      case '--':
        break;
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
      case '--client': {
        const name = take();
        const client = clientForAlias(name);
        if (!client) {
          throw new Error(
            `--client must be one of ${clientAliases().join(', ')}; got ${JSON.stringify(name)}`,
          );
        }
        options.client = client.provider;
        break;
      }
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
        clientUpstream = readUpstream(flag, take());
        break;
      case '--anthropic-upstream':
        upstreams.anthropic = readUpstream(flag, take());
        break;
      case '--openai-upstream':
        upstreams.openai = readUpstream(flag, take());
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

  if (clientUpstream !== undefined) {
    // Applied after the loop so the order of `--client` and `--upstream` on the
    // line does not change what they mean.
    upstreams[options.client ?? 'anthropic'] = clientUpstream;
  }
  if (Object.keys(upstreams).length > 0) options.upstreams = upstreams;
  return options;
}
