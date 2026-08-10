#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'dist/server/index.js');

if (!existsSync(entry)) {
  console.error('agent-devtools is not built yet. Run `npm run build` first.');
  process.exit(1);
}

await import(entry);
