# AGENTS.md

## Project purpose

Claude DevTools is a local observability proxy for Claude Code traffic. It reconstructs chat traces from Anthropic Messages HTTP/SSE exchanges and lets the UI drill from a trace node into the captured transport details. Captured requests can contain live credentials, prompts, and source code, so privacy and local-only operation are part of the product contract. Codex, OpenAI protocols, and generic multi-provider routing are outside the product scope.

## Repository map

- `src/core/` is the provider-agnostic domain and transport layer. Keep provider wire formats out of this directory except under `src/core/adapters/`.
- `src/core/adapters/anthropic.ts` owns Anthropic request/response/SSE translation into the unified model.
- `src/server/proxy.ts` captures and forwards traffic. Do not add bookkeeping that delays the client stream.
- `src/server/api.ts` exposes the local REST/SSE API and serves the production SPA.
- `src/server/persistence.ts` stores trace bodies in SQLite and restores reconstruction state.
- `src/web/` is the React SPA. It should render unified models and must not parse provider-specific protocols.
- `src/preview/` bakes a capture database into the static JSON published to GitHub Pages. `paths.ts` is isomorphic and shared with the SPA; everything else is Node-only build tooling.
- `preview/trace-preview.db` is the one SQLite file this repository commits on purpose. See `preview/README.md`.
- `design.md/` documents the visual system. Role-based color tokens live in `src/web/styles.css`.

## Setup and commands

Use pnpm because `pnpm-lock.yaml` is the repository lockfile.

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm typecheck
pnpm build
pnpm start
```

- `pnpm dev` starts the proxy/API watcher and Vite dev server.
- `pnpm preview:seed`, `pnpm preview:dev`, and `pnpm preview:build` build the static GitHub Pages preview. `pnpm typecheck` covers its sources through `tsconfig.preview.json`.
- Before handing off code changes, run `pnpm typecheck` and `pnpm build`.
- `pnpm test` runs the Node test suite. Add focused regression coverage when changing trace reconstruction, streaming, persistence, retention, or clearing behavior.
- The server uses `node:sqlite`; preserve and document the supported Node runtime range when changing runtime requirements.

## Architecture rules

- Keep `src/core/types.ts` as the unified provider-neutral model.
- Keep Anthropic wire behavior behind the `ProviderAdapter` seam; do not duplicate protocol event switches in server or UI code. Do not add provider registration or routing for non-Anthropic protocols without an explicit product-scope change.
- Preserve the distinction between top-level `system`, tag-wrapped injected `context`, and ordinary `user` text. Context detection is structural (`<tag>...</tag>`), never based on prompt wording.
- Preserve ESM conventions and include `.js` extensions in relative TypeScript imports that execute under NodeNext.
- Keep strict TypeScript settings intact. Avoid `any`, unchecked casts, or silently swallowing malformed provider data without an explicit fallback.
- A transport exchange, its trace nodes, conversation metadata, builder state, and persisted rows form one logical state transition. Clear, retention, restart, abort, and concurrent-stream changes must keep those layers consistent.
- Retention logic must account for every in-flight conversation, not only the request that most recently completed.

## Security and sensitive data

- Treat headers, request/response bodies, SSE frames, prompts, and tool results as sensitive.
- Keep both servers on IPv4 loopback unless the task explicitly introduces a complete authenticated remote-access design.
- Never expose credential reveal or destructive endpoints on an unauthenticated non-loopback listener.
- Redact sensitive headers before persistence. Preserve owner-only database/file permissions and owner-only storage directories.
- Do not log captured bodies or credentials to the terminal, test snapshots, fixtures, or review artifacts.
- `Clear` is expected to remove memory and disk state; changes to it must also reset reconstruction state and define behavior for in-flight requests.
- Anything reachable from `preview/trace-preview.db` becomes a public web page. Keep the committed capture synthetic unless the owner deliberately records their own, keep `src/preview/scrub.ts` failing the build on credential shapes, and never weaken it to get a build through.

## UI conventions

- Use role-named CSS variables from `src/web/styles.css`; do not put literal color decisions in React components.
- Keep theme changes limited to palette roles. Do not make theme selection change layout, spacing, or content.
- Keep dense transport output on the code-surface components and preserve readable whitespace for payloads and tool output.

## Generated and local files

- Do not hand-edit or commit `dist/` or `node_modules/`; they are generated/installed artifacts.
- Update `pnpm-lock.yaml` only through pnpm and only when dependencies change.
- SQLite databases and their `-wal`/`-shm` companions are local runtime data and must not enter the repository. `preview/trace-preview.db` is the single deliberate exception; its `-wal`/`-shm` companions are still excluded.
- `preview/public/` is generated by `pnpm preview:data`. Do not commit or hand-edit it.
- Treat `.scratch/` as local experimental material unless a task explicitly asks to productize it. Do not commit staged scratch files unintentionally.
- Preserve unrelated staged and unstaged user changes. Check `git status --short` before and after edits.

## Review expectations

- For behavior changes, exercise failure and lifecycle paths, not only the happy path: upstream errors, client aborts, concurrent conversations, restart/restore, capacity overflow, and Clear during a stream.
- Keep README behavior and security claims synchronized with implementation.
- Report validation commands exactly, including test coverage or environment-specific checks.
