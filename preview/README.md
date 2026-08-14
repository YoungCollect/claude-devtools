# Static preview

The Claude DevTools UI, published to GitHub Pages with a recorded session baked
in. It is the real SPA — same components, same trace reconstruction, same
Inspector — reading a directory of JSON instead of a proxy on loopback.

Live at `https://<user>.github.io/<repo>/` once Pages is enabled.

## The database

`trace-preview.db` is a normal capture database, the same format the tool writes
to `~/.claude-devtools/traces.db`. It is the one SQLite file this repository
commits on purpose; everything the build publishes comes from it.

The committed version is **synthetic**. `pnpm preview:seed` fabricates two
sessions and pushes them through the real capture pipeline — proxy hooks, trace
builder, persistence — so the data is structurally identical to a recording
without containing anyone's source code.

### Recording your own

```bash
pnpm preview:capture
```

That starts a second, fully separate capture — its own proxy, API, and Vite —
writing to `preview/trace-preview.db` instead of your normal database:

| | `pnpm dev` | `pnpm preview:capture` |
| --- | --- | --- |
| Capture proxy | `4141` | **`4143`** |
| API / UI | `4142` | **`4144`** |
| Vite | `5173` | **`5175`** |
| Database | `~/.claude-devtools/traces.db` | `preview/trace-preview.db` |

Nothing is shared, so both can run at once and neither can quietly record into
the other's database.

In another terminal, join **this** capture and work until the trace shows what
you want the preview to show. The port matters: `run` looks for a capture on the
API port it was given, and the bare command would find the ordinary one.

```bash
claude-devtools run --ui-port 4144
```

Watch it arrive at <http://127.0.0.1:4144>. If the convenience command is
unavailable, the equivalent manual launch is:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:4143 claude
```

Delete any conversation you would rather not publish from the sidebar before
stopping — deletes are durable, so the row is gone from the database too. Then
rebuild the payload and look at the result:

```bash
pnpm preview:seed     # or skip, if you captured your own
pnpm preview:data
pnpm preview:dev
```

> **Everything in this database becomes a public web page.** Prompts carry whole
> source files, file paths, and shell output. Credential *headers* are masked
> twice over — once by `redactHeaders` on the way to disk, once again in
> `presentRecord` — and `pnpm preview:data` additionally refuses to write any
> payload matching a known key format. None of that inspects prose. Read the
> conversations before you push.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm preview:seed` | Writes a synthetic `trace-preview.db` from fabricated traffic |
| `pnpm preview:capture` | Runs the proxy + UI against `trace-preview.db` to record a real session |
| `pnpm preview:data` | Bakes the database into `preview/public/preview-data/` |
| `pnpm preview:dev` | Preview data + Vite dev server on `127.0.0.1:5174/claude-devtools/` |
| `pnpm preview:build` | Production bundle into `preview/dist/` |
| `pnpm preview:serve` | Serves `preview/dist/` as a static host would |

`preview:dev` and `preview:build` both regenerate the payload first, so the dev
server and the deployed page never disagree about the data.

## How it differs from the running tool

A published page has no server, so three things change and each one says so
rather than pretending:

- **No change feed.** `subscribeToRevisions` reports connected once and never
  revises. The header shows a `preview` badge with the build date in place of
  the live ready/active indicator.
- **No mutations.** Clear, rename, and delete are hidden — a static host has
  nowhere to write them.
- **Bodies are baked in full.** The live server keeps request bodies on disk and
  loads them when the Inspector opens one. A static host cannot answer that
  second request, so `pnpm preview:data` inlines them. This is what makes the
  payload large; it is also what makes the Inspector work.

Everything else is the same code path. `presentRecord` — the function that
shapes a transport record for the Inspector — is shared between
`src/server/api.ts` and `src/preview/build.ts` precisely so the preview cannot
drift from the tool it is previewing.

## Deployment

`.github/workflows/pages.yml` runs `pnpm preview:build` on every push to `main`
that touches `src/`, the database, or the build config, then deploys
`preview/dist/`. It passes `PREVIEW_BASE=/<repo>/` so the bundle's asset paths
match wherever Pages serves it.

Enable it once, under **Settings → Pages → Source → GitHub Actions**.

Deep links work because the build writes `404.html` as a copy of the app shell:
Pages has no rewrite rules, so `/<repo>/c/conv_1` serves the 404 document, and
the client router reads the path it was given. `.nojekyll` keeps Pages from
running the upload through Jekyll.
