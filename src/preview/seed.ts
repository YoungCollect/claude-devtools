/**
 * Writes a synthetic trace database, so the preview pipeline has something to
 * build from before anyone has captured a real session.
 *
 * The exchanges here are fabricated, but nothing about the path they take is:
 * they are pushed through `CaptureRuntime`'s proxy hooks in the same order the
 * proxy fires them, so reconstruction, persistence, and retention all run for
 * real. A seeded database is therefore a valid input to `buildPreview`, and a
 * bug in trace reconstruction shows up here rather than only against live
 * traffic.
 *
 * It exists mainly so the committed preview is safe to publish: fabricated
 * prompts carry no customer source, no file paths from someone's disk, and no
 * credentials. Replace it with `pnpm preview:capture` when you want the
 * published demo to show real Claude Code traffic.
 */

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { Store } from '../core/store.js';
import { TraceBuilder } from '../core/trace-builder.js';
import type { SseFrame, TransportRecord } from '../core/types.js';
import { Persistence } from '../server/persistence.js';
import { CaptureRuntime } from '../server/runtime.js';

const MODEL = 'claude-opus-5';

/** One fabricated turn: what the user said, and what the assistant did back. */
interface Turn {
  user: string;
  /** Text the assistant streams before any tool call. */
  say: string;
  /** Optional tool call, and the result the next request carries back. */
  tool?: { name: string; input: Record<string, unknown>; result: string };
}

interface Session {
  title: string;
  sessionId: string;
  system: string;
  turns: Turn[];
}

const SESSIONS: Session[] = [
  {
    title: 'Add a retry to the upload client',
    sessionId: 'preview-session-upload',
    system:
      'You are Claude Code, an interactive CLI tool that helps users with software engineering tasks.',
    turns: [
      {
        user: 'The upload client gives up on the first 503. Add a bounded retry with backoff.',
        say: 'Let me look at how the client issues the request before changing its failure handling.',
        tool: {
          name: 'Read',
          input: { file_path: '/srv/media/upload-client.ts' },
          result: [
            'export async function upload(blob: Blob): Promise<UploadResult> {',
            '  const res = await fetch(ENDPOINT, { method: "POST", body: blob });',
            '  if (!res.ok) throw new UploadError(res.status);',
            '  return (await res.json()) as UploadResult;',
            '}',
          ].join('\n'),
        },
      },
      {
        user: 'Three attempts is enough. Do not retry a 4xx.',
        say:
          'Retrying a 4xx would resend a request the server has already rejected on its merits, ' +
          'so the loop only re-enters on 5xx and transport errors. Backoff doubles from 200ms, ' +
          'and the final failure carries the last status rather than a generic message.',
        tool: {
          name: 'Edit',
          input: {
            file_path: '/srv/media/upload-client.ts',
            old_string: '  if (!res.ok) throw new UploadError(res.status);',
            new_string: '  if (!res.ok && res.status < 500) throw new UploadError(res.status);',
          },
          result: 'Applied 1 edit to /srv/media/upload-client.ts',
        },
      },
      {
        user: 'Good. Does the test suite still pass?',
        say:
          'All 42 tests pass, including the two that assert a 400 is surfaced immediately — ' +
          'those would have hung for the full backoff window under an unconditional retry.',
      },
    ],
  },
  {
    title: 'Why is the trace list empty after restart?',
    sessionId: 'preview-session-restart',
    system:
      'You are Claude Code, an interactive CLI tool that helps users with software engineering tasks.',
    turns: [
      {
        user: 'After I restart the proxy the conversation list is empty, but the database file is still 40MB. Where did the traces go?',
        say: 'The bytes are on disk, so this is a load problem rather than a write problem. Let me check what restore reads.',
        tool: {
          name: 'Grep',
          input: { pattern: 'loadAll', output_mode: 'files_with_matches' },
          result: 'src/server/persistence.ts\nsrc/server/index.ts',
        },
      },
      {
        user: 'It reads them. So why does nothing render?',
        say:
          'Restore rebuilds the conversations and nodes, but the rows come back ordered by ' +
          '`updated_at` while the node sequence is global. A conversation whose last node was ' +
          'written before an older conversation was renamed lands out of order, and the UI ' +
          'renders the empty tail. The fix is to order nodes by `seq`, which restore already ' +
          'stores for exactly this reason.',
      },
    ],
  },
];

export interface SeedOptions {
  dbFile: string;
  /** Removes an existing database first, so a reseed is not an append. */
  fresh?: boolean;
}

export function seedPreviewDatabase({ dbFile, fresh = true }: SeedOptions): { requests: number } {
  const file = resolve(dbFile);
  if (fresh) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  }

  const store = new Store();
  const builder = new TraceBuilder(store);
  const persistence = new Persistence({ file, maxBytes: 256 * 1024 * 1024 });
  const runtime = new CaptureRuntime({ store, builder, persistence });

  // Fixed clock: a committed fixture should produce the same database on every
  // machine, and a preview built twice should differ only where the data does.
  let clock = Date.UTC(2026, 6, 14, 9, 0, 0);
  const tick = (ms: number): number => (clock += ms);

  let requests = 0;
  for (const session of SESSIONS) {
    // Claude Code resends the whole transcript every turn; the builder matches
    // a request to its conversation by that growing prefix, so the history has
    // to accumulate exactly as it does on the wire.
    const history: unknown[] = [];

    for (const turn of session.turns) {
      history.push({ role: 'user', content: [{ type: 'text', text: turn.user }] });

      const record = beginRecord(session, history, clock);
      runtime.hooks.onRequestStart(record);
      runtime.hooks.onRequestBody(record);

      tick(180);
      record.status = 200;
      record.statusText = 'OK';
      record.responseHeaders = {
        'content-type': 'text/event-stream',
        'anthropic-ratelimit-requests-remaining': '4998',
      };
      record.isStream = true;
      record.timing.ttfbAt = clock;
      runtime.hooks.onResponseStart(record);

      const assistantContent: unknown[] = [];
      for (const frame of streamTurn(turn, tick, assistantContent)) {
        record.sseFrames.push(frame);
        record.timing.firstTokenAt ??= frame.t;
        runtime.hooks.onStreamFrames(record, [frame]);
      }

      record.responseBytes = record.sseFrames.reduce((n, f) => n + f.raw.length, 0);
      record.timing.endedAt = tick(40);
      runtime.hooks.onComplete(record);
      requests += 1;

      history.push({ role: 'assistant', content: assistantContent });
      if (turn.tool) {
        const toolUseId = lastToolUseId(assistantContent);
        history.push({
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: toolUseId, content: turn.tool.result },
          ],
        });
      }
      tick(1_500);
    }
    tick(60_000);
  }

  persistence.close();
  return { requests };
}

/** A request record shaped exactly as the proxy would have built it. */
function beginRecord(session: Session, history: unknown[], now: number): TransportRecord {
  const body = {
    model: MODEL,
    max_tokens: 8192,
    stream: true,
    metadata: { user_id: session.sessionId },
    system: [{ type: 'text', text: session.system }],
    messages: structuredClone(history),
    tools: [
      { name: 'Read', description: 'Read a file from the filesystem', input_schema: {} },
      { name: 'Edit', description: 'Replace a string in a file', input_schema: {} },
      { name: 'Grep', description: 'Search file contents', input_schema: {} },
    ],
  };
  const raw = JSON.stringify(body);

  return {
    id: randomUUID(),
    provider: 'unknown',
    kind: 'other',
    method: 'POST',
    path: '/v1/messages',
    url: 'https://api.anthropic.com/v1/messages',
    // Masked on the way to disk by `redactHeaders`, and a placeholder to begin
    // with — a seed must not teach anyone that a real key belongs in a fixture.
    requestHeaders: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'placeholder-not-a-key',
      'user-agent': 'claude-cli/2.0.0 (external, cli)',
    },
    requestBodyRaw: raw,
    requestBody: body,
    isStream: false,
    sseFrames: [],
    timing: { startedAt: now },
    requestBytes: Buffer.byteLength(raw),
    responseBytes: 0,
  };
}

/**
 * The Anthropic streaming event sequence for one assistant turn.
 *
 * Written out rather than summarised because the Inspector's Raw tab shows
 * these frames verbatim, and the adapter reassembles the response from them —
 * a shortcut here would produce a preview whose transport pane disagrees with
 * its trace.
 */
function streamTurn(
  turn: Turn,
  tick: (ms: number) => number,
  assistantContent: unknown[],
): SseFrame[] {
  const frames: SseFrame[] = [];
  const emit = (event: string, data: unknown, gap = 30): void => {
    frames.push({
      t: tick(gap),
      event,
      data,
      raw: `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    });
  };

  const outputTokens = Math.ceil(turn.say.length / 4) + (turn.tool ? 40 : 0);
  emit('message_start', {
    type: 'message_start',
    message: {
      id: `msg_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: 4_120,
        output_tokens: 1,
        cache_read_input_tokens: 18_400,
        cache_creation_input_tokens: 0,
      },
    },
  });

  emit('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  // Word-sized deltas, as the wire actually carries them: one frame per token
  // is what makes the timing column in the Network view mean anything.
  for (const chunk of turn.say.match(/\S+\s*/g) ?? []) {
    emit('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: chunk },
    }, 18);
  }
  emit('content_block_stop', { type: 'content_block_stop', index: 0 });
  assistantContent.push({ type: 'text', text: turn.say });

  if (turn.tool) {
    const toolUseId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    emit('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: toolUseId, name: turn.tool.name, input: {} },
    });
    // Tool input arrives as JSON fragments, which is why the builder fingerprints
    // the reassembled object rather than the frames.
    const json = JSON.stringify(turn.tool.input);
    for (let i = 0; i < json.length; i += 24) {
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 24) },
      }, 12);
    }
    emit('content_block_stop', { type: 'content_block_stop', index: 1 });
    assistantContent.push({
      type: 'tool_use',
      id: toolUseId,
      name: turn.tool.name,
      input: turn.tool.input,
    });
  }

  emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: turn.tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  emit('message_stop', { type: 'message_stop' });
  return frames;
}

function lastToolUseId(content: unknown[]): string {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type?: string; id?: string } | undefined;
    if (block?.type === 'tool_use' && block.id) return block.id;
  }
  return 'toolu_unknown';
}
