import { readdirSync } from 'node:fs';
import path from 'node:path';

/** Recursively lists files under `dir` whose name ends with `extension`. */
export function listFiles(dir: string, extension: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, extension));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      out.push(full);
    }
  }
  return out;
}
