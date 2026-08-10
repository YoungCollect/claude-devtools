import { fingerprint } from '../fingerprint.js';
import type { SseFrame, TokenUsage, TransportRecord } from '../types.js';
import type {
  HistoryItem,
  HistorySegment,
  ParsedRequest,
  ProviderAdapter,
  StreamBlockEvent,
} from './types.js';

// Fingerprint recipes. The streaming path and the history path must agree
// exactly, so both sides go through these helpers and nowhere else.
const fpUser = (text: string) => fingerprint('user', text);
const fpSystemText = (text: string) => fingerprint('system_message', text);
const fpAssistant = (text: string) => fingerprint('assistant', text);
const fpThinking = (text: string) => fingerprint('thinking', text);
const fpToolCall = (id: string, name: string, input: unknown) =>
  fingerprint('tool_call', id, name, input);
const fpToolResult = (toolUseId: string, content: unknown) =>
  fingerprint('tool_result', toolUseId, content);

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',

  matches(record) {
    return pathname(record.path).includes('/v1/messages');
  },

  parseRequest(record) {
    const body = asRecord(record.requestBody);
    const path = pathname(record.path);
    const system = readSystem(body?.system);
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const tools = Array.isArray(body?.tools) ? body.tools : [];

    return {
      provider: 'anthropic',
      kind: classify(path, tools.length, messages.length),
      agent: detectAgent(record.requestHeaders),
      model: typeof body?.model === 'string' ? body.model : undefined,
      systemFp: fingerprint('system', system),
      system,
      history: messages.flatMap(readMessage),
    };
  },

  inspectRequest(record) {
    const body = asRecord(record.requestBody);
    if (!body) return undefined;
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    return {
      summary: [
        { label: 'model', value: asString(body?.model) ?? '—' },
        { label: 'messages', value: String(messages.length) },
        { label: 'tools', value: String(tools.length) },
        { label: 'max tokens', value: String(body?.max_tokens ?? '—') },
        { label: 'stream', value: String(body?.stream ?? false) },
      ],
      toolNames: tools.map((tool) => asString(asRecord(tool)?.name) ?? '?'),
      systemText: readSystem(body?.system),
    };
  },

  parseStreamFrames(frames) {
    const events: StreamBlockEvent[] = [];
    for (const frame of frames) {
      const data = asRecord(frame.data);
      const type = typeof data?.type === 'string' ? data.type : frame.event;

      switch (type) {
        case 'message_start': {
          const message = asRecord(data?.message);
          events.push({
            type: 'message_start',
            model: typeof message?.model === 'string' ? message.model : undefined,
            usage: readUsage(message?.usage),
            t: frame.t,
          });
          break;
        }
        case 'content_block_start': {
          const block = asRecord(data?.content_block);
          const kind = blockKind(block?.type);
          if (!kind) break;
          events.push({
            type: 'block_start',
            index: numberOr(data?.index, 0),
            kind,
            text: kind === 'assistant' ? asString(block?.text) : asString(block?.thinking),
            toolName: asString(block?.name),
            toolUseId: asString(block?.id),
            t: frame.t,
          });
          break;
        }
        case 'content_block_delta': {
          const delta = asRecord(data?.delta);
          const deltaType = asString(delta?.type);
          // `signature_delta` carries thinking-block cryptography, not content.
          if (deltaType === 'signature_delta') break;
          const text =
            asString(delta?.text) ?? asString(delta?.thinking) ?? asString(delta?.partial_json);
          if (text === undefined) break;
          events.push({
            type: 'block_delta',
            index: numberOr(data?.index, 0),
            text,
            t: frame.t,
          });
          break;
        }
        case 'content_block_stop':
          events.push({ type: 'block_stop', index: numberOr(data?.index, 0), t: frame.t });
          break;
        case 'message_delta': {
          const delta = asRecord(data?.delta);
          events.push({
            type: 'message_delta',
            stopReason: asString(delta?.stop_reason),
            usage: readUsage(data?.usage),
            t: frame.t,
          });
          break;
        }
        case 'error': {
          const error = asRecord(data?.error);
          events.push({
            type: 'error',
            error: `${asString(error?.type) ?? 'error'}: ${asString(error?.message) ?? 'unknown'}`,
            t: frame.t,
          });
          break;
        }
        default:
          break;
      }
    }
    return events;
  },

  parseResponseBody(record) {
    const t = record.timing.endedAt ?? Date.now();
    const body = asRecord(record.responseBody);
    if (!body) return [];

    if (body.type === 'error') {
      const error = asRecord(body.error);
      return [
        {
          type: 'error',
          error: `${asString(error?.type) ?? 'error'}: ${asString(error?.message) ?? 'unknown'}`,
          t,
        },
      ];
    }

    const events: StreamBlockEvent[] = [
      {
        type: 'message_start',
        model: asString(body.model),
        usage: readUsage(body.usage),
        t: record.timing.ttfbAt ?? t,
      },
    ];

    const content = Array.isArray(body.content) ? body.content : [];
    content.forEach((raw, index) => {
      const block = asRecord(raw);
      const kind = blockKind(block?.type);
      if (!kind) return;
      events.push({
        type: 'block_start',
        index,
        kind,
        text: kind === 'tool_call' ? undefined : (asString(block?.text) ?? asString(block?.thinking)),
        toolName: asString(block?.name),
        toolUseId: asString(block?.id),
        toolInput: block?.input,
        t,
      });
      events.push({ type: 'block_stop', index, t });
    });

    events.push({
      type: 'message_delta',
      stopReason: asString(body.stop_reason),
      usage: readUsage(body.usage),
      t,
    });
    return events;
  },

  fingerprintBlock(event) {
    if (event.kind === 'tool_call') {
      return fpToolCall(event.toolUseId ?? '', event.toolName ?? '', event.toolInput);
    }
    if (event.kind === 'thinking') return fpThinking(event.text ?? '');
    return fpAssistant(event.text ?? '');
  },
};

// ---------------------------------------------------------------------------

/**
 * Which requests belong in the Chat Trace.
 *
 * Claude Code interleaves real turns with side calls — `count_tokens` probes and
 * a small no-tools Haiku call that names the conversation. Those are genuine
 * traffic and stay in the Network view, but showing them as trace nodes buries
 * the actual agent loop. The reliable signal is the tool set: an agent turn
 * always ships its tools, a utility call never does.
 */
function classify(path: string, toolCount: number, messageCount: number) {
  if (path.includes('count_tokens')) return 'utility' as const;
  if (toolCount > 0) return 'conversation' as const;
  if (messageCount <= 2) return 'utility' as const;
  return 'conversation' as const;
}

function detectAgent(headers: Record<string, string>): string {
  const ua = (headers['user-agent'] ?? '').toLowerCase();
  if (ua.startsWith('claude-cli')) return 'claude-code';
  if (ua.includes('mastra')) return 'mastra';
  if (ua.includes('anthropic-sdk') || ua.includes('anthropic-ai')) return 'anthropic-sdk';
  return 'unknown';
}

function readSystem(system: unknown): string | undefined {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return undefined;
  return system
    .map((block) => asString(asRecord(block)?.text) ?? '')
    .filter(Boolean)
    .join('\n\n');
}

/** One provider message becomes zero or more history items, one per block. */
function readMessage(raw: unknown): HistoryItem[] {
  const message = asRecord(raw);
  if (!message) return [];
  const role = asString(message.role);
  const content = message.content;

  if (typeof content === 'string') {
    if (!content.trim()) return [];
    return [textHistoryItem(role, content)];
  }
  if (!Array.isArray(content)) return [];

  const items: HistoryItem[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block) continue;

    switch (block.type) {
      case 'text': {
        const text = asString(block.text) ?? '';
        // Empty text blocks are dropped on both sides of the fingerprint
        // comparison; the API is inconsistent about echoing them back.
        if (!text.trim()) break;
        items.push(textHistoryItem(role, text));
        break;
      }
      case 'thinking': {
        const text = asString(block.thinking) ?? '';
        if (!text.trim()) break;
        items.push({ fp: fpThinking(text), kind: 'thinking', text });
        break;
      }
      case 'tool_use': {
        const id = asString(block.id) ?? '';
        const name = asString(block.name) ?? '';
        items.push({
          fp: fpToolCall(id, name, block.input),
          kind: 'tool_call',
          toolUseId: id,
          toolName: name,
          toolInput: block.input,
        });
        break;
      }
      case 'tool_result': {
        const id = asString(block.tool_use_id) ?? '';
        items.push({
          fp: fpToolResult(id, block.content),
          kind: 'tool_result',
          toolUseId: id,
          toolResult: block.content,
          isError: block.is_error === true,
        });
        break;
      }
      case 'image':
      case 'document': {
        const label = `[${block.type}]`;
        items.push({ fp: fingerprint(block.type, block), kind: 'user', text: label });
        break;
      }
      default:
        break;
    }
  }
  return items;
}

function textHistoryItem(role: string | undefined, text: string): HistoryItem {
  if (role === 'assistant') return { fp: fpAssistant(text), kind: 'assistant', text };
  if (role === 'system') {
    return {
      fp: fpSystemText(text),
      kind: 'system',
      text,
      segments: [{ kind: 'system', text }],
    };
  }
  return {
    // Keep the fingerprint on the original provider block. Display segmentation
    // must not break matching against conversation state persisted by older builds.
    fp: fpUser(text),
    kind: 'user',
    text,
    segments: splitTaggedUserContent(text),
  };
}

/** Splits balanced `<tag>...</tag>` wrappers from ordinary user-authored text. */
export function splitTaggedUserContent(text: string): HistorySegment[] {
  const taggedBlock = /<([A-Za-z][\w:.-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/g;
  const segments: HistorySegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(taggedBlock)) {
    const index = match.index ?? 0;
    pushPlainSegment(segments, text.slice(cursor, index));
    const wrapped = match[0].trim();
    const tag = match[1];
    if (wrapped && tag) segments.push({ kind: 'context', contextTag: tag, text: wrapped });
    cursor = index + match[0].length;
  }
  pushPlainSegment(segments, text.slice(cursor));
  return segments;
}

function pushPlainSegment(segments: HistorySegment[], text: string): void {
  const plain = text.trim();
  if (plain) segments.push({ kind: 'user', text: plain });
}

function blockKind(type: unknown): StreamBlockEvent['kind'] {
  if (type === 'text') return 'assistant';
  if (type === 'thinking' || type === 'redacted_thinking') return 'thinking';
  if (type === 'tool_use') return 'tool_call';
  return undefined;
}

function readUsage(raw: unknown): TokenUsage | undefined {
  const usage = asRecord(raw);
  if (!usage) return undefined;
  const out: TokenUsage = {
    inputTokens: numberOrUndefined(usage.input_tokens),
    outputTokens: numberOrUndefined(usage.output_tokens),
    cacheCreationInputTokens: numberOrUndefined(usage.cache_creation_input_tokens),
    cacheReadInputTokens: numberOrUndefined(usage.cache_read_input_tokens),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

export function pathname(path: string): string {
  const query = path.indexOf('?');
  return query === -1 ? path : path.slice(0, query);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export type { SseFrame, TransportRecord, ParsedRequest };
