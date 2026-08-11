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

function customPropertyValues(block: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of block.matchAll(/(^|\s)(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    values.set(match[2]!, match[3]!.trim());
  }
  return values;
}

function resolveToken(name: string, values: Map<string, string>, references: Map<string, string>): string {
  let value = values.get(name) ?? references.get(name);
  assert.ok(value, `missing token value: ${name}`);
  const seen = new Set([name]);
  while (value.startsWith('var(')) {
    const next = value.match(/^var\((--[a-z0-9-]+)\)$/)?.[1];
    assert.ok(next, `unsupported token expression for ${name}: ${value}`);
    assert.ok(!seen.has(next), `token reference cycle while resolving ${name}`);
    seen.add(next);
    value = values.get(next) ?? references.get(next);
    assert.ok(value, `unresolved token reference ${next} from ${name}`);
  }
  return value;
}

function relativeLuminance(hex: string): number {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  assert.match(full, /^[0-9a-fA-F]{6}$/, `expected a six-digit hex colour, got ${hex}`);
  const channels = [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16));
  const [r, g, b] = channels.map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
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
  const references = customPropertyValues(extractBlock(css, ':root {'));
  const light = customPropertyValues(extractBlock(css, '@theme {'));
  const surface = resolveToken('--color-data-surface', light, references);
  const luminance = relativeLuminance(surface);
  assert.ok(
    luminance > 0.5,
    `--color-data-surface (${surface}) reads as a dark panel again (luminance ${luminance.toFixed(3)}) — ` +
      'this is the exact P0-01 regression the 2026-08-11 audit fixed',
  );
});

test('DataSurface foreground and syntax roles meet WCAG AA in light and dark', () => {
  const css = readFileSync(STYLES_PATH, 'utf8');
  const references = customPropertyValues(extractBlock(css, ':root {'));
  const themes = [
    ['light', customPropertyValues(extractBlock(css, '@theme {'))],
    ['dark', customPropertyValues(extractBlock(css, ":root[data-theme='dark'] {"))],
  ] as const;
  const foregrounds = [
    '--color-data-foreground',
    '--color-data-foreground-muted',
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

  for (const [theme, values] of themes) {
    const surface = resolveToken('--color-data-surface', values, references);
    for (const token of foregrounds) {
      const foreground = resolveToken(token, values, references);
      const ratio = contrastRatio(foreground, surface);
      assert.ok(ratio >= 4.5, `${theme} ${token} is ${ratio.toFixed(2)}:1 on DataSurface; expected >= 4.5:1`);
    }
  }
});

test('role and status badge pairs meet WCAG AA without borrowing token families', () => {
  const css = readFileSync(STYLES_PATH, 'utf8');
  const references = customPropertyValues(extractBlock(css, ':root {'));
  const themes = [
    ['light', customPropertyValues(extractBlock(css, '@theme {'))],
    ['dark', customPropertyValues(extractBlock(css, ":root[data-theme='dark'] {"))],
  ] as const;
  const pairs = [
    ...['success', 'warning', 'error'].map((name) => [`--color-status-${name}-fg`, `--color-status-${name}-bg`] as const),
    ...['user', 'assistant', 'system', 'context', 'thinking', 'tool', 'error'].map(
      (name) => [`--color-role-${name}-fg`, `--color-role-${name}-bg`] as const,
    ),
  ];

  for (const [theme, values] of themes) {
    for (const [foregroundToken, backgroundToken] of pairs) {
      const foreground = resolveToken(foregroundToken, values, references);
      const background = resolveToken(backgroundToken, values, references);
      const ratio = contrastRatio(foreground, background);
      assert.ok(ratio >= 4.5, `${theme} ${foregroundToken} is ${ratio.toFixed(2)}:1 on ${backgroundToken}`);
    }
  }
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

test('feature components never consume reference-palette tokens directly', () => {
  const offenders: string[] = [];
  for (const file of listFiles(WEB_DIR, '.tsx')) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.includes('--ref-')) offenders.push(`${path.relative(WEB_DIR, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], 'reference values must flow through semantic/component tokens');
});

test('retired code/markup token families and toolbar surface branches do not return', () => {
  const offenders: string[] = [];
  for (const file of listFiles(WEB_DIR, '.tsx')) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/\b(?:bg|text|border)-(?:code|markup)-|surface\??:\s*['"](?:canvas|code)/.test(line)) {
        offenders.push(`${path.relative(WEB_DIR, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'structured content must use DataSurface without canvas/code branching');
});

test('every var(--color-*) reference in styles.css resolves to a definition', () => {
  const css = readFileSync(STYLES_PATH, 'utf8');

  const defined = new Set<string>();
  for (const match of css.matchAll(/(^|[\s;{])(--color-[a-z0-9-]+)\s*:/g)) {
    defined.add(match[2]!);
  }

  const dangling = new Set<string>();
  for (const match of css.matchAll(/var\(\s*(--color-[a-z0-9-]+)/g)) {
    if (!defined.has(match[1]!)) dangling.add(match[1]!);
  }

  // A `var()` naming a token nobody defines is invalid at computed-value time:
  // the property silently falls back to its inherited or initial value rather
  // than erroring, so a retired token leaves a rule that still *parses* while
  // rendering as `transparent` / `currentColor`. Retiring the `chat-code-*`
  // family did exactly that to `.markdown-body.markdown-chat pre` — the
  // component layer had been grepped, this stylesheet had not.
  assert.deepEqual(
    [...dangling].sort(),
    [],
    'these --color-* tokens are referenced by styles.css but defined nowhere in it',
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
