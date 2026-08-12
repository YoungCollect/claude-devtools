# Claude DevTools

Local DevTools for Claude Code. A loopback-only proxy reconstructs a Claude Code
run as a **Chat Trace**, and every trace node drills into the **HTTP / SSE / timing**
that produced it.

```text
User message → Assistant → Tool call → Tool result
                                ↓ inspect
             Headers · Payload · Response · SSE frames · Timing · Raw
```

Claude DevTools is intentionally narrow: it supports Claude Code and the Anthropic
Messages protocol. Codex, OpenAI APIs, and generic multi-provider routing are outside
the product scope.

## Run it

Node.js 22.5 or newer is required because persistence uses `node:sqlite`.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start run
```

`run` starts the capture and launches Claude Code with `ANTHROPIC_BASE_URL` already
pointed at it. Arguments after `--` go to Claude unchanged:

```bash
pnpm start run -- --model claude-sonnet-4-5
```

The capture remains open after Claude exits so the completed trace is still available.
Press Ctrl-C to stop it.

To start Claude Code yourself:

```bash
pnpm start
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 claude
```

Open <http://127.0.0.1:4142>.

### Bare command

This is a private package, so link it once if you want `claude-devtools` on PATH:

```bash
pnpm link --global
claude-devtools run
```

### Development

```bash
pnpm dev
```

The proxy remains on `127.0.0.1:4141`; the API is on `127.0.0.1:4142`; Vite serves
the hot-reloading UI at <http://127.0.0.1:5173>. Server/core edits restart the server,
while persisted traces survive the restart.

### Options

```text
claude-devtools [options]
claude-devtools run [options] [-- <claude args>]
```

| Flag | Meaning |
| --- | --- |
| `--proxy-url <url>` | Loopback capture URL, for example `http://127.0.0.1:4141` |
| `--proxy-port <port>` | Capture proxy port |
| `--ui-port <port>` | UI and local API port |
| `--upstream <url>` | Anthropic-compatible upstream; defaults to `https://api.anthropic.com` |
| `--db <path>` | SQLite trace database |
| `--max-bytes <n>` | Stored body retention limit |
| `--max-requests <n>` | In-memory transport index limit |
| `--no-persist` | Keep traces only in memory |
| `--dev` | Redirect the UI to Vite |
| `-h`, `--help` | Print usage |
| `-v`, `--version` | Print the version |

Flags override `CLAUDE_DEVTOOLS_*` environment settings. Supported environment
variables are `CLAUDE_DEVTOOLS_PROXY_PORT`, `CLAUDE_DEVTOOLS_UI_PORT`,
`CLAUDE_DEVTOOLS_VITE_PORT`, `CLAUDE_DEVTOOLS_UPSTREAM`, `CLAUDE_DEVTOOLS_DB`,
`CLAUDE_DEVTOOLS_MAX_BYTES`, and `CLAUDE_DEVTOOLS_MAX_REQUESTS`.

Both listeners are fixed to IPv4 loopback. Captured traffic includes live credentials,
prompts, tool output, and source code and must not be exposed remotely.

## How trace reconstruction works

There is no Claude Code plugin or runtime instrumentation. The proxy reconstructs the
trace from Anthropic Messages requests and SSE responses:

1. The Anthropic adapter normalizes the request transcript into history blocks.
2. The builder prefix-diffs those blocks against each known conversation with the same
   session id and system prompt.
3. Assistant text, thinking, and tool calls materialize live from SSE frames.
4. Tool results appear in the next request and are joined to calls by `tool_use_id`.

Claude Code's `x-claude-code-session-id` separates independent runs. The system prompt
also remains part of identity because a `Task` subagent shares its parent session id but
uses a different prompt. Tagged injected content such as `<system-reminder>…</system-reminder>`
is detected structurally and displayed separately from human-authored user text.

Side calls such as token counting and conversation-title generation are folded into a
collapsed **Background activity** section at their actual position in Chat Trace. A late
side-call response appears later in the timeline instead of moving back under its request;
an immediately adjacent request/response pair is shown as one exchange card. Expanding a
section reveals its exchange cards and Inspector links; Network keeps every captured
exchange visible. Tool duration is inferred from the gap between the response requesting
a tool and the next request carrying its result.

An adjacent request and response share a compact `#N METHOD PATH STATUS DURATION` heading.
When concurrent traffic separates them, Chat Trace keeps numbered `#N REQUEST` and
`#N RESPONSE` cards at their actual positions instead; method, path, status, and duration
stay together on the REQUEST heading.

## Architecture

```text
src/
  core/
    types.ts                transport and trace model
    trace-builder.ts        conversation, tool, and subagent reconstruction
    adapters/anthropic.ts   Anthropic Messages request/SSE translation
    store.ts                in-memory state and change feed
    redact.ts               credential masking
  server/
    proxy.ts                streaming loopback proxy
    api.ts                  local REST/SSE API and production SPA
    persistence.ts          SQLite persistence and retention
  web/                      React trace, network, and inspector UI
```

The adapter seam is retained to keep Anthropic wire shapes out of the builder, store,
and UI. It is not a promise of multi-provider support: Claude DevTools has exactly one
registered adapter and one upstream.

## Validation

```bash
pnpm test
pnpm typecheck
pnpm build
```

`Clear` removes memory and disk state and invalidates in-flight reconstruction. Stored
headers are redacted, database directories and files are owner-only, and retention
operates on whole conversations while accounting for concurrent streams.
