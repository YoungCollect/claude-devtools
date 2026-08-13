/**
 * `pnpm preview:data` — turns the committed trace database into the static
 * payload tree the GitHub Pages build serves.
 *
 * Run by both `preview:dev` and `preview:build`, so the dev server and the
 * deployed page are always looking at the same generated data.
 *
 * `pnpm preview:seed` writes the database itself, from fabricated traffic.
 */

import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { buildPreview } from './build.js';
import { CredentialLeakError } from './scrub.js';
import { seedPreviewDatabase } from './seed.js';

/** Committed sample capture. Overridable for a scratch database. */
const DEFAULT_DB = 'preview/trace-preview.db';

/**
 * Vite's `publicDir` for the preview build: everything here is copied to the
 * site root verbatim. Generated, never committed.
 */
const DEFAULT_OUT = 'preview/public';

const USAGE = `Build the static preview payload from a captured trace database.

Usage
  pnpm preview:data [--db <file>] [--out <dir>]   Bake the payload tree
  pnpm preview:seed [--db <file>]                 Write a synthetic database

Options
  --db <file>    Trace database to read, or to write when seeding (default: ${DEFAULT_DB})
  --out <dir>    Output root; payloads land in <dir>/preview-data (default: ${DEFAULT_OUT})
  -h, --help     Print this and exit
`;

interface Options {
  command: 'build' | 'seed';
  dbFile: string;
  outDir: string;
}

export function parsePreviewArgs(argv: readonly string[]): Options | 'help' {
  const seeding = argv[0] === 'seed';
  const options: Options = {
    command: seeding ? 'seed' : 'build',
    dbFile: DEFAULT_DB,
    outDir: DEFAULT_OUT,
  };
  const rest = seeding ? argv.slice(1) : argv;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) continue;
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const take = (): string => {
      const value = equals === -1 ? rest[++i] : arg.slice(equals + 1);
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      return value;
    };
    switch (flag) {
      case '-h':
      case '--help':
        return 'help';
      case '--db':
        options.dbFile = take();
        break;
      case '--out':
        options.outDir = take();
        break;
      default:
        throw new Error(`unknown option ${flag}\n\n${USAGE}`);
    }
  }
  return options;
}

function main(): void {
  let options: Options | 'help';
  try {
    options = parsePreviewArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (options === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  if (options.command === 'seed') {
    const { requests } = seedPreviewDatabase({ dbFile: options.dbFile });
    console.log(
      `seeded ${relative(process.cwd(), resolve(options.dbFile))} ` +
        `with ${requests} synthetic requests`,
    );
    return;
  }

  if (!existsSync(resolve(options.dbFile))) {
    console.error(
      `No trace database at ${options.dbFile}.\n\n` +
        'Create one, either way:\n' +
        '  pnpm preview:seed      Fabricated traffic — safe to publish as-is\n' +
        '  pnpm preview:capture   Record your own Claude Code session into it\n\n' +
        'The capture form runs the proxy against this file; drive Claude Code through it\n' +
        'until the UI shows the conversations you want, stop it, then rerun this.\n',
    );
    process.exit(1);
  }

  try {
    const result = buildPreview(options);
    const out = relative(process.cwd(), resolve(options.outDir));
    console.log(
      `preview data → ${out}/preview-data  ` +
        `(${result.conversations} conversations, ${result.nodes} nodes, ` +
        `${result.transport} requests, ${formatBytes(result.bytes)})`,
    );
  } catch (error) {
    if (error instanceof CredentialLeakError) {
      console.error(`\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

main();
