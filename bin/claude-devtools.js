#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'dist/server/index.js');

if (!existsSync(entry)) {
  console.error('claude-devtools is not built yet. Run `pnpm build` first.');
  process.exit(1);
}

// Every flag is the server's to interpret (see src/server/cli.ts); this wrapper
// only exists to apply the runtime flag below, so it passes them through whole.

// Re-exec so the runtime flag applies: node:sqlite is still marked experimental
// and would otherwise print a notice above our own banner on every start.
const { status } = spawnSync(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', entry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(status ?? 0);
