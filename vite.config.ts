import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The UI is a plain SPA. In dev it runs on :5173 and proxies /api to the
// devtools server on :4142; in prod it is built to dist/web and served by that
// same server, so the UI never needs to know its own origin.
export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  server: {
    // Pinned to IPv4 loopback: Vite's default `localhost` resolves to ::1 on
    // macOS, which the server's dev redirect (and every other port in this
    // tool) would fail to reach.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // Anchored regex, not the bare '/api' prefix: that form also matches
      // `/api.ts` — this app's own `src/web/api.ts` module — and proxies the
      // frontend's source file to the backend, which never resolves.
      '^/api/': {
        target: 'http://127.0.0.1:4142',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
