# Agent DevTools

DevTools for AI agents. A local proxy reconstructs an agent's run as a **Chat Trace**,
and every node on that trace drills straight down into the **HTTP / SSE / timing** that
produced it.

```
User message → Assistant → Tool call → Tool result
                                ↓ inspect
             Headers · Payload · Response · SSE frames · Timing · Raw
```

The point is not "another proxy" or "another observability dashboard". It's the link:
you start from *what the agent did* and end at *what actually went over the wire*,
without changing views or correlating ids by hand.

---

## Run it

```bash
npm install
npm run build
npm start
```

Then point an agent at the proxy:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 claude
```

Open <http://127.0.0.1:4142>. Traffic appears live.

For development (Vite HMR on :5173, API on :4142):

```bash
npm run dev
```

| Port | What |
| ---- | ---- |
| 4141 | Capture proxy — the agent's `ANTHROPIC_BASE_URL` |
| 4142 | UI + API |
| 5173 | Vite dev server (dev only) |

Environment overrides: `AGENT_DEVTOOLS_PROXY_PORT`, `AGENT_DEVTOOLS_UI_PORT`,
`AGENT_DEVTOOLS_UPSTREAM`, `AGENT_DEVTOOLS_HOST`, `AGENT_DEVTOOLS_MAX_REQUESTS`.

---

## How the trace is reconstructed

There is no agent-side instrumentation. Everything comes from the HTTP traffic, which
works because of one property of chat-completion APIs:

**Every request carries the entire transcript, and each request is a prefix-extension
of the last.**

So the builder (`src/core/trace-builder.ts`):

1. Normalises each request's `messages[]` into per-block **history items** and
   fingerprints them.
2. Diffs that list against the transcript it already knows for each conversation. The
   longest prefix match wins; everything past the shared prefix is **newly revealed**.
3. Takes assistant output from the **response stream** instead, materialising nodes live
   as `content_block_*` frames arrive.

That split matters, because chat events and HTTP requests are not 1:1:

- One response streams back several assistant / thinking / tool-call nodes.
- A **tool result never appears in any response** — it only shows up inside the *next*
  request's history. Tool nodes are joined across requests by `tool_use_id`.
- A request with no shared prefix is a new conversation: a fresh session, or a subagent.
  If a `Task` tool call is still outstanding when one appears, it is linked as that
  subagent's trace and nested under its parent.

### Tool execution time, for free

The gap between *the end of the response that requested a tool* and *the start of the
request carrying its result* is the tool's real execution window. So each trace shows
both halves of a turn — how long the model took, and how long the tool took — with no
instrumentation on either side.

### Utility traffic

Claude Code interleaves real turns with side calls (`count_tokens`, a small no-tools
Haiku call that names the conversation). They stay in the Network view but are kept off
the Chat Trace; the reliable signal is the tool set — an agent turn always ships its
tools, a utility call never does.

---

## Architecture

```
src/
  core/                     provider-agnostic — no Anthropic types leak past adapters/
    types.ts                Unified Agent Event Model (transport layer + trace layer)
    trace-builder.ts        prefix-diff reconstruction, conversation & subagent grouping
    store.ts                in-memory store + change feed
    sse.ts                  incremental SSE frame parser
    fingerprint.ts          stable stringify + hash (isomorphic)
    redact.ts               credential masking
    adapters/
      types.ts              ProviderAdapter seam
      anthropic.ts          Anthropic Messages API ⇄ unified model
  server/
    proxy.ts                :4141 streaming capture proxy
    api.ts                  :4142 REST + SSE change feed + static UI
  web/                      React SPA — Trace, Inspector, Network
```

Adding **Codex/OpenAI** or **Mastra** means writing one `ProviderAdapter`. The store, the
trace builder and the entire UI are already provider-agnostic: agent runtime and model
provider are separate concepts throughout (`agent: claude-code` vs `provider: anthropic`).

---

## Design

Two themes, toggled from the top right and remembered in `localStorage` (first visit
follows the OS preference):

- **Light** — the Claude design system in `design.md/design-claude.md`: warm cream canvas
  (`#faf9f5`), coral accent (`#cc785c`), dark navy product surfaces (`#181715`).
- **Dark** — the original terminal-adjacent palette: near-black canvas (`#0b0d10`), blue
  accent (`#7aa2f7`), purple tool colour.

### One token layer, two palettes

Every colour in `src/web/styles.css` names a **role**, never a hue: `canvas`, `code`,
`tool-fg`, `muted`, `primary`. The two palettes fill the same role set, so switching
themes is a CSS-variable swap on `<html data-theme>` — no component contains a colour
decision, and no component knows which theme is active.

The interesting role is `code`. In light it is the system's `code-window-card` — a dark
navy card on cream. In dark that same card would be near-black on near-black, so the
role inverts to a *raised* panel with a visible border. Same name, opposite mechanics;
that inversion is precisely what a role-named token can express and a hue-named one
cannot.

Type and density are deliberately **not** themed. A toggle that also reflowed the page
would make comparing the two a different task every time.

Two further adaptations, since the system is written for marketing surfaces and this is a
dense debugging tool:

- **Spacing is compressed.** The system's 96px section rhythm would let a trace show
  three events per screen. Surfaces, colour and type voice are taken as-is; the spacing
  scale is used at its small end (8/12/16/24px).
- **The `code-window-card` does the heavy lifting.** Every payload, tool result, SSE
  frame list and raw body renders as a dark navy card on cream — which is precisely the
  cream-to-dark pacing the system asks for, and it separates machine output from human
  content at a glance.

Serif is reserved for the human's own words: the wordmark, conversation titles, and user
messages in the trace. The accent stays scarce in both themes — selection state, active
toggles, the inspect affordance — never decorative. Tool and status colours use the
light theme's documented sparing accents (teal, amber) rather than introducing a fourth
surface tone; dark maps the same roles onto its green and purple.

Copernicus and StyreneB are licensed; the app uses the substitutes the system documents
(Tiempos Headline / Cormorant Garamond / Georgia, and Inter), all resolved locally so
the tool works offline with no webfont fetch.

## Security

Captured traffic contains live credentials and whole source files.

- Both servers bind **127.0.0.1** only.
- `authorization` / `x-api-key` / cookies are **masked** in every API response. The
  Inspector's "secrets masked" toggle reveals them per request, on demand.
- Nothing is written to disk and nothing is sent anywhere. Restarting clears everything.

---

## V0 scope and known limits

Shipped: Claude Code → Anthropic, HTTP + SSE capture, Chat Trace, Inspector
(Overview / Headers / Payload / Response / SSE / Timing / Raw), Network list, live
streaming updates, subagent nesting.

Known limits, honestly:

1. **Context compaction starts a new trace.** Compaction rewrites the head of the
   transcript, so the prefix match legitimately fails. A rewind that keeps a shared
   prefix is detected and marked; a full compaction is not.
2. **Only agents that honour `ANTHROPIC_BASE_URL` are captured.** No CA certificate, no
   system proxy — which is the point, but it also means nothing else is intercepted.
3. **Tool timing includes agent overhead.** The measured window is
   response-end → next-request-start, so it also contains the agent's own bookkeeping and
   any permission prompt the human sat on. Parallel batches share one window and are
   marked `·batch`.
4. **Memory only**, capped at `AGENT_DEVTOOLS_MAX_REQUESTS` (default 1000). No replay, no
   persistence, no export yet.
5. `accept-encoding` is rewritten to `identity` upstream so bodies stay readable; the
   Headers tab shows what the agent actually sent and notes the rewrite.
6. Only the Anthropic adapter exists. The seam for others is in place but unexercised.
