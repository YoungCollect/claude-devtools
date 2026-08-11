import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { listFiles } from './helpers/list-files.js';

/**
 * Static checks for the token architecture the 2026-08-11 product design
 * audit asked for (§5, "governance"): light/dark parity, no literal colours
 * escaping into components, and no `*-fg` role used as a background. These
 * are exactly the kind of drift a visual review catches once and a later
 * change reintroduces silently — the audit's whole point was that the
 * previous colour work "had been checked once, on one theme."
 */

const STYLES_PATH = path.join(import.meta.dirname, '..', 'src', 'web', 'styles.css');
const WEB_DIR = path.join(import.meta.dirname, '..', 'src', 'web');

function extractBlock(css: string, startMarker: string): string {
  const start = css.indexOf(startMarker);
  assert.ok(start >= 0, `expected to find ${JSON.stringify(startMarker)} in styles.css`);
  const braceStart = css.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(braceStart + 1, i);
    }
  }
  throw new Error(`unterminated block for ${JSON.stringify(startMarker)}`);
}

function customPropertyNames(block: string): Set<string> {
  const names = new Set<string>();
  for (const match of block.matchAll(/(^|\s)(--[a-z0-9-]+)\s*:/g)) {
    names.add(match[2]!);
  }
  return names;
}

test('every --color-* role defined for light is redefined for dark, and vice versa', () => {
  const css = readFileSync(STYLES_PATH, 'utf8');
  const light = customPropertyNames(extractBlock(css, '@theme {'));
  const dark = customPropertyNames(extractBlock(css, ":root[data-theme='dark'] {"));

  const lightColorRoles = [...light].filter((name) => name.startsWith('--color-'));
  const darkColorRoles = [...dark].filter((name) => name.startsWith('--color-'));

  const missingFromDark = lightColorRoles.filter((name) => !dark.has(name));
  const missingFromLight = darkColorRoles.filter((name) => !light.has(name));

  assert.deepEqual(
    missingFromDark,
    [],
    'these --color-* roles are defined for light but never overridden for dark',
  );
  assert.deepEqual(
    missingFromLight,
    [],
    'these --color-* roles are defined for dark but do not exist in the light @theme block',
  );
});

test('the DataSurface and syntax token families exist in both themes', () => {
  const css = readFileSync(STYLES_PATH, 'utf8');
  const light = customPropertyNames(extractBlock(css, '@theme {'));
  const dark = customPropertyNames(extractBlock(css, ":root[data-theme='dark'] {"));

  const required = [
    '--color-data-surface',
    '--color-data-surface-nested',
    '--color-data-surface-control',
    '--color-data-foreground',
    '--color-data-foreground-muted',
    '--color-data-border',
    '--color-data-divider',
    '--color-syntax-key',
    '--color-syntax-string',
    '--color-syntax-number',
    '--color-syntax-boolean',
    '--color-syntax-null',
    '--color-syntax-tag',
    '--color-syntax-attribute',
    '--color-syntax-punctuation',
    '--color-syntax-event',
  ];

  for (const token of required) {
    assert.ok(light.has(token), `missing from light @theme: ${token}`);
    assert.ok(dark.has(token), `missing from dark override: ${token}`);
  }
});

test("light theme's DataSurface stays off near-black (P0-01 regression guard)", () => {
  const css = readFileSync(STYLES_PATH, 'utf8');
  const light = extractBlock(css, '@theme {');
  const match = light.match(/--color-data-surface:\s*(#[0-9a-fA-F]{3,8})/);
  assert.ok(match, 'expected --color-data-surface to be a literal hex value in the light block');
  const hex = match![1]!.replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  // Relative luminance (sRGB, WCAG formula) — a near-black card sits under
  // 0.05; the warm-grey panel the audit asked for sits well above it.
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  assert.ok(
    luminance > 0.5,
    `--color-data-surface (#${full}) reads as a dark panel again (luminance ${luminance.toFixed(3)}) — ` +
      'this is the exact P0-01 regression the 2026-08-11 audit fixed',
  );
});

const TAILWIND_PALETTE_HUES = [
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
];

const LITERAL_COLOR_UTILITY = new RegExp(
  String.raw`\b(?:bg|text|border|ring|from|to|via|fill|stroke|decoration|outline|divide|caret|accent|shadow)-` +
    String.raw`(?:\[#|\[rgb|(?:${TAILWIND_PALETTE_HUES.join('|')})-\d{2,3}\b)`,
);
const LITERAL_HEX_OR_RGB_IN_CLASS = /className=(?:"[^"]*"|\{`[^`]*`\}|\{cx\([^)]*\)\})/;

test('no literal hex/rgb colour and no default Tailwind palette hue in src/web/**/*.tsx', () => {
  const offenders: string[] = [];
  for (const file of listFiles(WEB_DIR, '.tsx')) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (LITERAL_COLOR_UTILITY.test(line)) {
        offenders.push(`${path.relative(WEB_DIR, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    'AGENTS.md: "Use role-named CSS variables ... do not put literal color decisions in React components"',
  );
});

test('no *-fg role token used as a background utility', () => {
  const offenders: string[] = [];
  const bgFgPattern = /\bbg-(?:\[[^\]]*-fg\]|[a-z][a-z-]*-fg)\b/;
  for (const file of listFiles(WEB_DIR, '.tsx')) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (bgFgPattern.test(line)) {
        offenders.push(`${path.relative(WEB_DIR, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    '"*-fg" tokens are text/foreground roles; using one as a bg-* utility crosses the role\'s own contract',
  );
});
