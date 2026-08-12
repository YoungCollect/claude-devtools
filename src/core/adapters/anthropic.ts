import { fingerprint } from '../fingerprint.js';
import { splitTaggedUserContent } from '../tagged-content.js';
import { asRecord, asString, numberOr, numberOrUndefined, pathname } from './wire.js';
import type { SseFrame, TokenUsage, TransportRecord } from '../types.js';
import type {
  HistoryItem,
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

  claimsPath(path) {
    return pathname(path).includes('/v1/messages');
  },

  parseRequest(record) {
    const body = asRecord(record.requestBody);
    const path = pathname(record.path);
    const system = readSystem(body?.system);
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const tools = Array.isArray(body?.tools) ? body.tools : [];

    return {
      provider: 'anthropic',
      kind: classify(path, tools.length, messages.length, readSessionId(record.requestHeaders)),
      agent: detectAgent(record.requestHeaders),
      model: typeof body?.model === 'string' ? body.model : undefined,
      sessionId: readSessionId(record.requestHeaders),
      systemFp: fingerprint('system', system),
      system,
      history: messages.flatMap((message, index) => readMessage(message, index)),
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
      // Named only when present, so the Inspector never offers to expand a
      // field this particular request did not send.
      bodyFields: {
        ...(body.system !== undefined ? { system: 'system' } : {}),
        ...(Array.isArray(body.messages) ? { history: 'messages' } : {}),
        ...(Array.isArray(body.tools) ? { tools: 'tools' } : {}),
      },
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

  /** Claude Code dispatches subagents through `Task`. */
  isSubagentTool(toolName) {
    return toolName === 'Task';
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
 * Which requests are a session's own turns, and which are side calls it makes
 * along the way.
 *
 * Claude Code interleaves real turns with side calls — `count_tokens` probes, a
 * quota check, and a no-tools call that names the conversation. Both belong to
 * the session; only the turns belong in its transcript, because a side call's
 * prompt and reply are about the session rather than part of it.
 *
 * The tool set is the strongest signal: an agent turn always ships its tools.
 * It cannot be the only one, because agents that declare no tools at all exist
 * — the SDK and Mastra, both of which `detectAgent` recognises. Treating every
 * short tool-less request as utility hid their conversations outright: a
 * single-turn exchange never reached the trace, and a longer one only appeared
 * from its third message on.
 *
 * So the tool-less case is narrowed by the run id. A side call is a request
 * that names a session, declares no tools, and carries a single message — the
 * SDK and Mastra send no run id at all, so their one-shot turns cannot match.
 *
 * The narrowing used to be a `max_tokens` ceiling instead, on the theory that a
 * side call is given barely any room to answer. It is not: Claude Code's title
 * call asks for the same 64000-token budget as a real turn, so every one of
 * them was read as a conversation and opened its own trace.
 */
function classify(
  path: string,
  toolCount: number,
  messageCount: number,
  sessionId: string | undefined,
) {
  if (path.includes('count_tokens')) return 'utility' as const;
  if (toolCount > 0) return 'conversation' as const;
  if (sessionId !== undefined && messageCount <= 1) return 'utility' as const;
  return 'conversation' as const;
}

/**
 * Claude Code stamps every call with its own run id. That is a direct answer to
 * "is this the same session?", which the trace builder would otherwise have to
 * infer, so it is worth reading even though only one runtime sends it today.
 *
 * Kept in the adapter, not the builder: the header name is a wire detail.
 */
function readSessionId(headers: Record<string, string>): string | undefined {
  const id = headers['x-claude-code-session-id'];
  return id && id.trim() ? id : undefined;
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
function readMessage(raw: unknown, messageIndex: number): HistoryItem[] {
  const message = asRecord(raw);
  if (!message) return [];
  const role = asString(message.role);
  const content = message.content;

  if (typeof content === 'string') {
    if (!content.trim()) return [];
    return [textHistoryItem(role, content, ['messages', messageIndex, 'content'])];
  }
  if (!Array.isArray(content)) return [];

  const items: HistoryItem[] = [];
  for (const [blockIndex, rawBlock] of content.entries()) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    const sourcePath = ['messages', messageIndex, 'content', blockIndex] as const;

    switch (block.type) {
      case 'text': {
        const text = asString(block.text) ?? '';
        // Empty text blocks are dropped on both sides of the fingerprint
        // comparison; the API is inconsistent about echoing them back.
        if (!text.trim()) break;
        items.push(textHistoryItem(role, text, sourcePath));
        break;
      }
      case 'thinking': {
        const text = asString(block.thinking) ?? '';
        if (!text.trim()) break;
        items.push({ fp: fpThinking(text), kind: 'thinking', text, sourcePath: [...sourcePath] });
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
          sourcePath: [...sourcePath],
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
          sourcePath: [...sourcePath],
        });
        break;
      }
      case 'image':
      case 'document': {
        const label = `[${block.type}]`;
        items.push({
          fp: fingerprintAttachment(block),
          kind: 'user',
          text: label,
          sourcePath: [...sourcePath],
        });
        break;
      }
      default:
        break;
    }
  }
  return items;
}

function textHistoryItem(
  role: string | undefined,
  text: string,
  sourcePath: readonly (string | number)[],
): HistoryItem {
  if (role === 'assistant') {
    return { fp: fpAssistant(text), kind: 'assistant', text, sourcePath: [...sourcePath] };
  }
  if (role === 'system') {
    return {
      fp: fpSystemText(text),
      kind: 'system',
      text,
      sourcePath: [...sourcePath],
      segments: [{ kind: 'system', systemSource: 'message', text }],
    };
  }
  return {
    // Keep the fingerprint on the original provider block. Display segmentation
    // must not break matching against conversation state persisted by older builds.
    fp: fpUser(text),
    kind: 'user',
    text,
    sourcePath: [...sourcePath],
    segments: splitTaggedUserContent(text),
  };
}

/**
 * Identifies an attachment without hashing its payload.
 *
 * The whole block used to go through `stableStringify` and then a per-character
 * hash — and because every request replays the entire transcript, a 5 MB image
 * was re-serialised and re-hashed on every single turn, on the synchronous path
 * that forwards the agent's request.
 *
 * Media type, length, and both ends of the payload separate any two
 * attachments a session actually holds. The fingerprint only has to tell blocks
 * apart within one conversation, never resist collision.
 */
function fingerprintAttachment(block: Record<string, unknown>): string {
  const source = asRecord(block.source);
  const data = asString(source?.data) ?? '';
  return fingerprint(
    asString(block.type) ?? 'attachment',
    asString(source?.media_type) ?? '',
    asString(source?.url) ?? '',
    data.length,
    data.slice(0, 64),
    data.slice(-64),
  );
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

export type { SseFrame, TransportRecord, ParsedRequest };
