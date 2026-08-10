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

Requires Node.js 22.5 or newer because persistence uses the built-in
`node:sqlite` module.

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

### Developing on it

```bash
pnpm dev
```

Starts the proxy and API with `tsx watch`, and Vite with React Fast Refresh. **Open
<http://127.0.0.1:5173>** — that is the UI that hot-reloads; :4142 redirects there so
either port works. The agent still points at :4141 exactly as in production, so you can
edit the UI mid-session and watch the trace re-render without touching the agent.

Editing anything under `src/server` or `src/core` restarts the process and briefly drops
:4141 — but the traces survive, since they are persisted and reloaded on boot. Editing
`src/web` doesn't restart anything; that is pure Fast Refresh.

| Port | What |
| ---- | ---- |
| 4141 | Capture proxy — the agent's `ANTHROPIC_BASE_URL` |
| 4142 | API; serves the built UI in production, redirects to Vite in dev |
| 5173 | Vite dev server — **the URL to open during `pnpm dev`** |

Environment overrides: `AGENT_DEVTOOLS_PROXY_PORT`, `AGENT_DEVTOOLS_UI_PORT`,
`AGENT_DEVTOOLS_UPSTREAM`, `AGENT_DEVTOOLS_MAX_REQUESTS`, `AGENT_DEVTOOLS_DB`, and
`AGENT_DEVTOOLS_MAX_BYTES`. Both servers are intentionally fixed to `127.0.0.1`.

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

### Trace roles

The trace distinguishes transport roles from injected context without matching specific
prompt wording:

- The request's top-level `system` content is shown as a right-aligned,
  collapsible `system prompt` banner.
- A `messages[]` item whose role is `system` is shown as a right-aligned,
  collapsible `system` banner.
- Inside a `user` text block, balanced `<tag>...</tag>` wrappers are split into
  `context` nodes labelled with their tag name, such as `system-reminder`,
  `local-command-caveat`, or `command-name`.
- Text outside those wrappers remains `user`, representing the human-authored message,
  and is shown as a right-aligned chat bubble.
- Assistant replies are shown as left-aligned chat bubbles.
- The original provider block still contributes one conversation fingerprint, so this
  display-only split does not change transcript matching.

System and context nodes span the full column rather than sitting in a chat bubble:
what they hold is a rendered document — markdown, code fences, tag outlines — and a
bubble width reflows that for no reason. Only the human's and the assistant's own
messages keep the narrow conversational measure.

Opening the Inspector is an explicit `inspect →` button, revealed in the row's gutter on
hover, rather than a click anywhere on the row. Rows carry their own controls —
expanding a context block, folding a tag, selecting text out of a payload — and a
row-wide handler turned every one of those into a near miss that threw the side panel
open. The button fades rather than unmounting, so it stays reachable by keyboard.

### Tool execution time, for free

The gap between *the end of the response that requested a tool* and *the start of the
request carrying its result* is the tool's real execution window. So each trace shows
both halves of a turn — how long the model took, and how long the tool took — with no
instrumentation on either side.

### Utility traffic

Claude Code interleaves real turns with side calls (`count_tokens`, a small no-tools
Haiku call that names the conversation). They remain captured in the transport store,
but are kept out of the conversation-scoped Network and Chat Trace unless they can be
attributed to that conversation. The reliable signal is the tool set — an agent turn
always ships its tools, a utility call never does.

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
    xml-outline.ts          lenient, lossless tag parser for pseudo-XML content
    redact.ts               credential masking
    adapters/
      types.ts              ProviderAdapter seam
      anthropic.ts          Anthropic Messages API ⇄ unified model
  server/
    proxy.ts                :4141 streaming capture proxy
    api.ts                  :4142 REST + SSE change feed + static UI
    persistence.ts          SQLite storage; bodies on disk, metadata resident
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
themes is a CSS-variable swap on `<html data-theme>` — content components contain no
colour decision. Only the theme control reads the active theme to render its state.

Scrollbars are hidden globally rather than styled. The view is dense by design — trace
column, payload card, SSE frame list and Inspector can all scroll at once, and a bar on
each was carving the layout into strips. Scrolling itself is untouched (verified: wheel
and scroll gesture both move the trace column with a 0px scrollbar gutter). The trade:
markdown code fences and wide tables still scroll sideways without advertising it.

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

## Content rendering

Agent text is shown three ways, switchable per block: **Rendered** (markdown),
**Structure** (tag outline) and **Raw**. The raw view is not a nicety — rendering is
interpretation, and this is a tool for finding out what the model was actually sent, so
every rendered view has to be checkable against the bytes on the wire.

- **System prompts** lead with markdown (`src/web/components/ContentViewer.tsx`).
- **`<tag>…</tag>` blocks** — Claude Code's `<system-reminder>`, `<env>` and friends —
  lead with the structure outline.

The choice is one shared, persisted setting rather than per-block state: with several
blocks open at once, having them disagree about whether you are reading source or prose
is the confusing state. Switching one switches the rest live (via `useSyncExternalStore`),
and a block that cannot honour the choice — a tag block has no markdown view — falls back
to its own default instead of going blank.

The toggle stays *inside* the expanded region, in the panel card's own header, right
aligned, alongside a copy-source button. A view switch cannot show anything while the
block is collapsed, so hoisting the buttons out would put dead controls on every row of
a list whose job is to be scanned — and floating them above the card read as chrome
belonging to the trace row rather than to the panel. The header does not scroll with the
body.

**Rendered and Structure share the canvas; only Raw gets the dark code card.** Both of
the first two are renderings, and flipping the whole panel dark when switching between
them read as a mode change that had not happened. Raw keeps the card because those are
the literal bytes off the wire, which is what the dark surface is reserved for. The
outline therefore needs syntax colours for the *canvas*, so `markup-*` roles exist
separately from the `code-*`/`json-*` roles that print on navy (all four clear WCAG AA
against the canvas in both themes: 4.66–10.34 light, 5.38–10.57 dark).

Rendered panels are memoised. The trace refetches its nodes on every store revision, so
during a streaming response an open markdown panel was re-parsing its whole source about
every 80ms — measured at 1207ms of script time across one 3s turn for a 20 kB system
prompt, versus 27ms after memoising.

Markdown uses **`react-markdown` + `remark-gfm`**. Deliberately without `rehype-raw`:
this text is whatever the agent sent, so embedded HTML must stay inert, and the library's
default is to escape it (its URL transform already drops `javascript:` links).

The tag outline is **hand-written** (`src/core/xml-outline.ts`), which needs justifying
given `react-xml-viewer` exists. That library requires well-formed XML, and this content
is not XML — it is prose wrapped in tags. Fed `if (a < b && c > d) return;` it silently
reparses the text as a tag with attributes `b="true" &&="true" c="true"`. For a debugging
tool, quietly displaying something the agent never sent is worse than displaying nothing.

So the parser recognises *structure* and leaves everything else alone: a tag opens only
if a matching close exists, an unmatched `<` stays literal, attributes are captured
verbatim. Its safety property is `serialize(parse(x)) === x` for all inputs — structure
may go unrecognised, content is never altered — enforced in `tests/xml-outline.test.ts`,
including 3000 randomly assembled fragments.

## Storage

Traces are persisted to SQLite (`node:sqlite` — no dependency, no native build) at
`~/.agent-devtools/traces.db`. Disable with `--no-persist`.

This is not primarily about surviving restarts. **One Claude Code turn ships ~233 kB of
request body** — the whole transcript, resent every turn — and the in-memory record held
both the raw string and its parsed object. The old count-based cap (1000 requests) said
nothing about size, so a normal working session could exhaust memory long before hitting
it.

So the split is: **metadata stays resident, bodies live on disk and load only when the
Inspector opens a request.** Measured over 150 requests of ~200 kB each: +27 MB resident
with persistence on, +80 MB with `--no-persist`. Under an active retention cap, resident
size plateaus instead of growing.

Restarting resumes rather than resets: conversations, trace nodes and the reconstruction
fingerprints are restored, so a still-running agent's next request **extends its existing
trace** instead of opening a second one for the same session.

| Setting | Default | Meaning |
| ------- | ------- | ------- |
| `AGENT_DEVTOOLS_DB` | `~/.agent-devtools/traces.db` | Database location |
| `AGENT_DEVTOOLS_MAX_BYTES` | 1 GB | Stored body bytes before the oldest conversations are dropped |
| `--no-persist` | off | Memory only; traces lost on restart |

Retention is byte-based and evicts whole conversations, oldest first, while protecting
every conversation currently in flight. If protected conversations alone exceed the
cap, their oldest request bodies are discarded while trace metadata remains available.
When a conversation is evicted, the trace builder forgets it too — otherwise a
still-running agent session could keep matching against history the store no longer has,
and its requests would accumulate unreachable and un-evictable.

`node:sqlite` is still marked experimental in Node 22, so the entry points pass
`--disable-warning=ExperimentalWarning` to keep the notice off the banner. Running
`node dist/server/index.js` directly will print it; nothing else differs.

## Security

Captured traffic contains live credentials and whole source files.

- Both servers bind **127.0.0.1** only.
- **Credentials are never written to disk.** `authorization` / `x-api-key` / cookies are
  masked *before* the record is stored, so a trace file that outlives its session cannot
  leak a live token. The Inspector's reveal toggle returns the real value only for
  requests still held in memory by the current process; reloaded ones stay masked.
- The database is `0600` inside a `0700` directory.
- Nothing is sent anywhere. `Clear` wipes memory and disk; deleting a conversation
  removes only that chat's trace nodes and transport rows from both layers.

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
4. **No replay and no export yet.** Traces persist and reload, but you cannot re-issue a
   captured request or hand a session file to someone else.
5. `accept-encoding` is rewritten to `identity` upstream so bodies stay readable; the
   Headers tab shows what the agent actually sent and notes the rewrite.
6. Only the Anthropic adapter exists. The seam for others is in place but unexercised.
