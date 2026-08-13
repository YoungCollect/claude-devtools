import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { StateSnapshot, TraceNode, TransportDetail } from '../src/core/types.js';
import { buildPreview } from '../src/preview/build.js';
import {
  PREVIEW_INDEX_FILE,
  previewFileStem,
  previewNodesFile,
  previewTransportFile,
  type PreviewIndex,
} from '../src/preview/paths.js';
import { CredentialLeakError, findCredential } from '../src/preview/scrub.js';
import { seedPreviewDatabase } from '../src/preview/seed.js';
import { listFiles } from './helpers/list-files.js';

function workspace(): { dbFile: string; outDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'claude-devtools-preview-'));
  return { dbFile: join(dir, 'trace.db'), outDir: join(dir, 'public') };
}

function readJson<T>(outDir: string, relativePath: string): T {
  return JSON.parse(readFileSync(join(outDir, relativePath), 'utf8')) as T;
}

test('bakes a seeded capture into the payload tree the browser asks for', () => {
  const { dbFile, outDir } = workspace();
  seedPreviewDatabase({ dbFile });
  const result = buildPreview({ dbFile, outDir });

  assert.ok(result.conversations > 0, 'seed should produce conversations');
  assert.ok(result.transport > 0, 'seed should produce transport records');

  const index = readJson<PreviewIndex>(outDir, PREVIEW_INDEX_FILE);
  const state = index.state as StateSnapshot;
  assert.equal(state.conversations.length, result.conversations);
  assert.equal(state.transport.length, result.transport);
  // A published capture is finished by definition; a non-zero count would drive
  // the UI's traffic indicator on a page where nothing can arrive.
  assert.equal(state.activeRequests, 0);

  // Every path the static client derives has to exist, because a static host
  // answers a miss with a 404 rather than an empty result.
  for (const conversation of state.conversations) {
    const { nodes } = readJson<{ nodes: TraceNode[] }>(
      outDir,
      previewNodesFile(conversation.id),
    );
    for (const node of nodes) assert.equal(node.conversationId, conversation.id);
  }
  for (const summary of state.transport) {
    readJson<{ record: TransportDetail }>(outDir, previewTransportFile(summary.id));
  }
});

test('bakes bodies in full, because a static host cannot serve them on demand', () => {
  const { dbFile, outDir } = workspace();
  seedPreviewDatabase({ dbFile });
  buildPreview({ dbFile, outDir });

  const index = readJson<PreviewIndex>(outDir, PREVIEW_INDEX_FILE);
  const state = index.state as StateSnapshot;
  const first = state.transport[0];
  assert.ok(first, 'expected at least one request');

  const { record } = readJson<{ record: TransportDetail }>(
    outDir,
    previewTransportFile(first.id),
  );
  assert.equal(record.bodiesOffloaded, false);
  assert.ok(record.requestBodyRaw, 'request body should be inlined');
  assert.ok(record.sseFrames.length > 0, 'stream frames should be inlined');
  // The Inspector renders these; producing them here is the whole reason the
  // preview shares `presentRecord` with the live API.
  assert.ok(record.derivedTiming.frameCount > 0);
  assert.ok(record.assembledResponse);
  assert.ok(record.requestInspection);
});

test('masks credential headers on the way into a published payload', () => {
  const { dbFile, outDir } = workspace();
  seedPreviewDatabase({ dbFile });
  buildPreview({ dbFile, outDir });

  const index = readJson<PreviewIndex>(outDir, PREVIEW_INDEX_FILE);
  const first = (index.state as StateSnapshot).transport[0];
  assert.ok(first);
  const { record } = readJson<{ record: TransportDetail }>(
    outDir,
    previewTransportFile(first.id),
  );

  const apiKey = record.requestHeaders['x-api-key'];
  assert.ok(apiKey, 'seed sends an api key header');
  assert.match(apiKey, /•/, 'api key must be masked, not published verbatim');
});

test('refuses to write a payload carrying a live-looking credential', () => {
  const { dbFile, outDir } = workspace();
  seedPreviewDatabase({ dbFile });

  // Reach past the redaction boundary the way a real capture would: a prompt
  // that quotes a key is body text, and no header rule ever sees it.
  const leaked = `sk-ant-api03-${'A1b2C3d4E5f6G7h8'.repeat(3)}`;
  const db = new DatabaseSync(dbFile);
  const row = db.prepare('SELECT id, bodies FROM transport LIMIT 1').get() as {
    id: string;
    bodies: string;
  };
  const bodies = JSON.parse(row.bodies) as { requestBodyRaw?: string };
  bodies.requestBodyRaw = `${bodies.requestBodyRaw ?? ''}${leaked}`;
  db.prepare('UPDATE transport SET bodies = ? WHERE id = ?').run(
    JSON.stringify(bodies),
    row.id,
  );
  db.close();

  assert.throws(() => buildPreview({ dbFile, outDir }), CredentialLeakError);
});

test('names the credential it found without repeating the value', () => {
  const error = new CredentialLeakError('Anthropic API key', 'preview-data/transport/x.json');
  assert.match(error.message, /Anthropic API key/);
  assert.match(error.message, /published publicly/);
});

test('does not mistake a masked secret for a live one', () => {
  // `maskSecret`'s output keeps the head of the key, which is exactly the part a
  // naive prefix check would fire on.
  assert.equal(findCredential('sk-ant-oat…••••••…9f2c'), undefined);
  assert.equal(findCredential('Bearer abc…••••••…7d10'), undefined);
  assert.ok(findCredential(`sk-ant-api03-${'x'.repeat(40)}`));
  assert.ok(findCredential('-----BEGIN OPENSSH PRIVATE KEY-----'));
});

test('keeps ids that are not safe file names out of the output paths', () => {
  // Today every id is `conv_<n>` or a UUID. This guards the day one is not.
  assert.equal(previewFileStem('conv_12'), 'conv_12');
  assert.equal(previewFileStem('4f0e-9a1b-42'), '4f0e-9a1b-42');
  for (const hostile of ['../../etc/passwd', 'a/b', 'x'.repeat(200), 'has space']) {
    const stem = previewFileStem(hostile);
    assert.match(stem, /^h_[0-9a-f]{16}$/);
    assert.ok(!previewNodesFile(hostile).includes('..'));
  }
  // Distinct ids must not collide into one file.
  assert.notEqual(previewFileStem('a/b'), previewFileStem('a/c'));
});

test('rebuilding replaces the previous payload rather than layering onto it', () => {
  const { dbFile, outDir } = workspace();
  seedPreviewDatabase({ dbFile });
  buildPreview({ dbFile, outDir });

  // A file from an older build, named after a conversation that no longer
  // exists. Leaving it behind would publish a trace the database has dropped.
  const stale = join(outDir, previewNodesFile('conv_stale'));
  writeFileSync(stale, '{"nodes":[]}');

  buildPreview({ dbFile, outDir });
  assert.ok(!listFiles(outDir, '.json').includes(stale));
});
