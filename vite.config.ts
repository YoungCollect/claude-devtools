import { copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { reactClickToComponent } from "vite-plugin-react-click-to-component";
import tailwindcss from '@tailwindcss/vite';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * Where the preview generator leaves its output. Vite copies a `publicDir`
 * verbatim to the site root, which is exactly the contract `src/preview/paths.ts`
 * describes — `preview-data/index.json` on disk becomes `<base>preview-data/index.json`
 * in the browser.
 */
const PREVIEW_PUBLIC_DIR = fileURLToPath(new URL('./preview/public', import.meta.url));

/**
 * Subdirectory the preview is published under.
 *
 * GitHub project Pages serve from `https://<user>.github.io/<repo>/`, so every
 * asset and route has to carry that prefix. The workflow passes the repository
 * name; the default matches this repository so a local `pnpm preview:build`
 * produces the same bundle CI does.
 */
function previewBase(env: NodeJS.ProcessEnv): string {
  const raw = env.PREVIEW_BASE ?? '/agent-devtools/';
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

/**
 * The two files GitHub Pages needs that a bundler does not produce.
 *
 * `404.html` is the SPA fallback: Pages has no rewrite rules, so a visitor
 * opening `/agent-devtools/c/conv_3` directly gets the 404 document, and making
 * it a copy of the app shell lets the client router read the path it was given.
 * `.nojekyll` stops Pages from running the upload through Jekyll, which
 * silently drops files and directories beginning with an underscore.
 */
function githubPagesFiles(outDir: string): Plugin {
  return {
    name: 'claude-devtools-github-pages-files',
    apply: 'build',
    closeBundle() {
      copyFileSync(`${outDir}/index.html`, `${outDir}/404.html`);
      writeFileSync(`${outDir}/.nojekyll`, '');
    },
  };
}

// The UI is a plain SPA. In dev it runs on :5173 and proxies /api to the
// devtools server on :4142; in prod it is built to dist/web and served by that
// same server, so the UI never needs to know its own origin.
//
// `--mode github` builds a third thing: the same SPA with its API replaced by
// a directory of baked JSON, published to GitHub Pages. It has no server to
// talk to, so it gets a base path, a public directory of generated payloads,
// and the static-host fallbacks above.
export default defineConfig(({ mode }) => {
  const isPreview = mode === 'github';
  // Deliberately outside `dist/`: package.json's `files` ships all of `dist/`,
  // and the preview site is a deploy artifact, not part of the published npm
  // package — putting it there would upload the whole Pages bundle, baked trace
  // data included, to the registry with every release.
  const outDir = isPreview ? `${projectRoot}preview/dist` : '../../dist/web';

  return {
    root: 'src/web',
    base: isPreview ? previewBase(process.env) : '/',
    // Read by `src/web/api.ts` to pick its data source. A string rather than a
    // boolean because Vite's env values are always strings.
    define: {
      'import.meta.env.VITE_STATIC_PREVIEW': JSON.stringify(String(isPreview)),
    },
    // Only the preview build has static payloads to ship. Left unset elsewhere
    // so the normal build does not depend on a generated directory existing.
    ...(isPreview ? { publicDir: PREVIEW_PUBLIC_DIR } : {}),
    plugins: [
      react(),
      reactClickToComponent(),
      tailwindcss(),
      ...(isPreview ? [githubPagesFiles(outDir)] : []),
    ],
    resolve: {
      // Mirrors the `@/*` path mapping in tsconfig.json. Vite's `root` is already
      // `src/web`, but `root` is not an import alias — without this, shadcn/ui's
      // generated `@/lib/utils` imports fail to resolve at build time.
      alias: {
        '@': fileURLToPath(new URL('./src/web', import.meta.url)),
      },
    },
    server: {
      // Pinned to IPv4 loopback: Vite's default `localhost` resolves to ::1 on
      // macOS, which the server's dev redirect (and every other port in this
      // tool) would fail to reach.
      host: '127.0.0.1',
      // The preview dev server is a second thing to have running, so it gets
      // its own port and can sit beside a live capture on 5173.
      port: isPreview ? 5174 : 5173,
      strictPort: true,
      // A preview reads files, never the API. Leaving the proxy on would send
      // its requests to a devtools server that may not even be running.
      ...(isPreview
        ? {}
        : {
            proxy: {
              // Anchored regex, not the bare '/api' prefix: that form also matches
              // `/api.ts` — this app's own `src/web/api.ts` module — and proxies the
              // frontend's source file to the backend, which never resolves.
              '^/api/': {
                target: 'http://127.0.0.1:4142',
                changeOrigin: false,
              },
            },
          }),
    },
    build: {
      outDir,
      emptyOutDir: true,
    },
  };
});
