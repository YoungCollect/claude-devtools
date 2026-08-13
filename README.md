# Claude DevTools

<p align="center">
  Local network and context observability for Claude Code.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oneyoung/claude-devtools"><img alt="npm version" src="https://img.shields.io/npm/v/%40oneyoung%2Fclaude-devtools?style=flat-square"></a>
  <a href="https://github.com/YoungCollect/agent-devtools/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/YoungCollect/agent-devtools/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <img alt="Node.js 22.5+" src="https://img.shields.io/badge/Node.js-%E2%89%A522.5-339933?style=flat-square&logo=nodedotjs&logoColor=white">
</p>

Claude DevTools answers two questions that are difficult to answer from a chat
transcript alone:

1. **What crossed the network?** Inspect every Anthropic Messages request,
   response, SSE frame, header, payload, status, byte count, and timing.
2. **What context did Claude actually receive?** Reconstruct the conversation
   and distinguish top-level system prompts, tag-wrapped injected context,
   ordinary user text, assistant output, thinking, tool calls, and tool results.

```text
Claude Code ──HTTP / SSE──▶ Claude DevTools ──HTTP / SSE──▶ Anthropic
                                  │
                                  ├─ Chat Trace: context and tool lifecycle
                                  └─ Network: request / response evidence
```

It is intentionally focused on Claude Code and the Anthropic Messages protocol.
It is not an agent SDK, a prompt evaluator, or a generic multi-provider router.

## Features

- **Local and non-invasive** — no Claude Code plugin, runtime hook, or prompt
  injection. Both listeners are fixed to IPv4 loopback, and capture bookkeeping
  never waits in front of the client response stream.
- **Context analysis** — separates request-level `system`, structurally tagged
  context such as `<system-reminder>…</system-reminder>`, and human-authored
  `user` content without guessing from prompt wording.
- **Live chat trace** — rebuilds user messages, assistant text, thinking, tool
  calls, tool results, subagents, and background activity as streaming events
  arrive.
- **Tool lifecycle** — joins calls and results by `tool_use_id`, groups parallel
  calls, and derives tool duration across request boundaries.
- **Network inspector** — drills into request and response headers, parsed JSON,
  raw bodies, individual SSE frames, errors, status, bytes, TTFB, and total time.
- **Source comparison** — send captured system, context, message, and tool
  content to the built-in diff view to compare what changed between requests.
- **Persistent, bounded history** — restores traces from SQLite after restart and
  evicts complete conversations under a configurable retention budget.
- **Credential-aware storage** — redacts sensitive headers before persistence,
  creates owner-only storage paths, and makes **Clear** remove memory, disk, and
  reconstruction state, including in-flight captures.
- **Concurrent-session reconstruction** — keeps overlapping Claude Code sessions
  and subagents distinct while preserving the real order of side calls and
  transport events.

## Quick start

Node.js 22.5 or newer is required because persistence uses `node:sqlite`.
Claude Code must already be installed and available as `claude`.

Run without a global install:

```bash
npx @oneyoung/claude-devtools run
```

Or install the CLI globally:

```bash
npm install --global @oneyoung/claude-devtools
claude-devtools run
```

`run` starts the local capture, opens a Claude Code process with
`ANTHROPIC_BASE_URL` already configured, and leaves the trace UI available at
<http://127.0.0.1:4142>. Arguments after `--` pass to Claude Code unchanged:

```bash
claude-devtools run -- --model claude-sonnet-4-5
```

The capture remains open when Claude exits so you can inspect the completed
trace. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop it.

### Start the capture first

Start the capture:

```bash
claude-devtools
```

Then join that capture and start Claude Code from another terminal:

```bash
claude-devtools run
```

If a capture is already running, another `claude-devtools run` joins it instead
of opening a competing SQLite writer.

If the convenience command is unavailable, the equivalent manual launch is:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 claude
```

## CLI reference

```text
claude-devtools [options]
claude-devtools run [options] [-- <claude args>]
```

| Flag | Description | Default |
| --- | --- | --- |
| `--proxy-url <url>` | Loopback capture URL | `http://127.0.0.1:4141` |
| `--proxy-port <port>` | Capture proxy port | `4141` |
| `--ui-port <port>` | UI and local API port | `4142` |
| `--upstream <url>` | Anthropic-compatible upstream | `https://api.anthropic.com` |
| `--db <path>` | SQLite trace database | `~/.claude-devtools/traces.db` |
| `--max-bytes <n>` | Stored body retention budget | `1 GiB` |
| `--max-requests <n>` | In-memory transport index limit | `5000` |
| `--no-persist` | Keep traces in memory only | off |
| `--dev` | Redirect the UI to Vite | off |
| `-h`, `--help` | Print usage | — |
| `-v`, `--version` | Print the package version | — |

Flags override their `CLAUDE_DEVTOOLS_*` environment equivalents:
`PROXY_PORT`, `UI_PORT`, `VITE_PORT`, `UPSTREAM`, `DB`, `MAX_BYTES`, and
`MAX_REQUESTS`.

## How reconstruction works

Claude Code sends the full message history again on each Anthropic Messages
request. Claude DevTools uses that property to reconstruct a trace without
instrumenting the client:

1. The Anthropic adapter translates request history and SSE events into a
   provider-neutral model.
2. The trace builder prefix-diffs that history against known conversations with
   the same session identity and system prompt.
3. Assistant text, thinking, and tool calls materialize live from SSE frames.
4. The next request reveals tool results, which are joined to calls by
   `tool_use_id`.

Claude Code's `x-claude-code-session-id` separates runs. The system prompt also
participates in identity because a `Task` subagent can share its parent's
session ID while using a different prompt.

Side traffic such as token counting and title generation appears as collapsed
**Background activity** at its actual position in the timeline. The **Network**
view retains every captured exchange, including aborted streams and upstream
errors, so the reconstructed trace always has transport evidence behind it.

## Privacy and data lifecycle

Captured data can include live API credentials, prompts, source code, file
contents, and tool output. Treat the local database as sensitive.

- The proxy and UI/API listen only on `127.0.0.1`; non-loopback hosts are
  rejected.
- Sensitive headers are redacted before records reach persistence.
- The database directory and files use owner-only permissions.
- `--no-persist` avoids disk storage, while still applying the memory budget.
- **Clear** permanently removes all captured conversations and invalidates
  currently in-flight reconstruction.

Do not expose either port through a tunnel, reverse proxy, container port, or
remote bind without adding a complete authentication and authorization layer.

## Local development

This repository uses pnpm and requires Node.js 22.5 or newer.

```bash
git clone https://github.com/YoungCollect/agent-devtools.git
cd agent-devtools
pnpm install --frozen-lockfile
pnpm dev
```

Development services:

| Service | Address |
| --- | --- |
| Capture proxy | `http://127.0.0.1:4141` |
| Local API / production UI | `http://127.0.0.1:4142` |
| Vite development UI | `http://127.0.0.1:5173` |

Server and core edits restart the server; Vite hot-reloads the React UI; stored
traces survive development restarts.

`pnpm preview:capture` runs a second capture on its own ports (`4143`, `4144`,
`5175`) writing to its own database, so it can record a preview session
alongside an ordinary `pnpm dev` without either one adopting the other's
traffic. `CLAUDE_DEVTOOLS_PROXY_PORT`, `CLAUDE_DEVTOOLS_UI_PORT`, and
`CLAUDE_DEVTOOLS_VITE_PORT` move both the server and its Vite together.

### Static preview

The UI is also published as a standalone page with a recorded session baked in,
so it can be read without installing anything. It is the same SPA reading a
directory of JSON instead of a live proxy — no server, no capture, no network
access to anything.

```bash
pnpm preview:seed     # write a synthetic preview/trace-preview.db
pnpm preview:dev      # serve it at 127.0.0.1:5174/agent-devtools/
pnpm preview:build    # production bundle into preview/dist/
```

`.github/workflows/pages.yml` deploys it on every push to `main`. The capture it
publishes is fabricated by default; recording your own means publishing your own
prompts, which is why [`preview/README.md`](preview/README.md) covers that
separately.

Before opening a pull request, run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

User-visible changes should also include a release note:

```bash
pnpm changeset
```

Changesets maintains the package version and `CHANGELOG.md` through an automated
release pull request. Maintainers can follow the full [release
guide](docs/releasing.md).

## Architecture

```text
src/
  core/
    types.ts                provider-neutral transport and trace model
    trace-builder.ts        conversation, tool, and subagent reconstruction
    adapters/anthropic.ts   Anthropic Messages and SSE translation
    store.ts                in-memory state and change feed
    redact.ts               credential masking
  server/
    proxy.ts                non-blocking loopback capture proxy
    api.ts                  local REST/SSE API and production SPA
    transport-view.ts       record shaping shared by the API and the preview
    persistence.ts          SQLite persistence and retention
  web/                      React trace, network, diff, and inspector UI
  preview/                  bakes a capture into the static GitHub Pages build
```

Anthropic wire formats stop at the adapter boundary. The builder, storage layer,
and UI consume unified models; this keeps the domain clean without promising
support for protocols outside the project's Claude-only scope.

## Contributing

Issues and focused pull requests are welcome. Changes to reconstruction,
streaming, persistence, retention, or clearing behavior should include regression
coverage for failure and lifecycle paths—not only the happy path.

## License

Licensed under the [Apache License 2.0](LICENSE).
