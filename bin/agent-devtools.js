#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'dist/server/index.js');

if (!existsSync(entry)) {
  console.error('agent-devtools is not built yet. Run `npm run build` first.');
  process.exit(1);
}

// Re-exec so the runtime flag applies: node:sqlite is still marked experimental
// and would otherwise print a notice above our own banner on every start.
const { status } = spawnSync(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', entry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(status ?? 0);
