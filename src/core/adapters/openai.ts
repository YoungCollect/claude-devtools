import { fingerprint } from '../fingerprint.js';
import { splitTaggedUserContent } from '../tagged-content.js';
import type { TokenUsage } from '../types.js';
import type { HistoryItem, ParsedRequest, ProviderAdapter, StreamBlockEvent } from './types.js';
import { asArray, asRecord, asString, numberOrUndefined, pathname } from './wire.js';

/**
 * OpenAI Chat Completions.
 *
 * Scope is deliberately one wire format: `POST /v1/chat/completions`, which is
 * what the OpenAI SDKs, every OpenAI-compatible gateway, and agent runtimes
 * pointed at one speak. The newer Responses API (`/v1/responses`) is a
 * different protocol — different request shape, different event names — and is
 * not claimed here. Traffic to it stays visible in the Network view as
 * unmatched transport rather than being half-parsed into a wrong trace.
 *
 * Two things differ from Anthropic in ways the rest of the system can feel:
 *
 *   - There is no top-level `system` field. The system prompt is the leading
 *     run of `system`/`developer` messages, so that prefix is lifted out of the
 *     history and reported as the request's prompt — which is what keeps
 *     `systemFp` stable across the turns of one run, and therefore what lets
 *     the builder recognise a continuation.
 *   - There is no `content_block_stop`. Blocks are opened from the chunk that
 *     carries `delta.role` (the only "this message is starting" signal the
 *     protocol has) and closed either on `finish_reason` or, for anything still
 *     open when the stream ends, by the builder at completion.
 */

// Fingerprint recipes. The streaming path and the history path must agree
// exactly, so both sides go through these helpers and nowhere else.
const fpUser = (text: string) => fingerprint('user', text);
const fpSystemText = (text: string) => fingerprint('system_message', text);
const fpAssistant = (text: string) => fingerprint('assistant', text);
const fpThinking = (text: string) => fingerprint('thinking', text);
const fpToolCall = (id: string, name: string, input: unknown) =>
  fingerprint('tool_call', id, name, input);
const fpToolResult = (toolCallId: string, content: unknown) =>
  fingerprint('tool_result', toolCallId, content);

/**
 * Block numbering.
 *
 * Chat Completions numbers choices and tool calls but not blocks, so the index
 * the unified model wants is derived: each choice gets a band, and within it
 * slot 0 is the assistant text, slot 1 the reasoning trace, and slot 2 onward
 * the tool calls in the order the protocol numbers them. Deriving it from the
 * frame — rather than counting as we go — is what keeps this adapter a pure
 * function of the frames it is handed, which it has to be: it is called once
 * per network batch during a stream and once over the whole list afterwards.
 */
const CHOICE_BAND = 1000;
const TEXT_SLOT = 0;
const REASONING_SLOT = 1;
const TOOL_SLOT = 2;

const blockIndex = (choice: number, slot: number) => choice * CHOICE_BAND + slot;

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',
  provider: 'openai',

  claimsPath(path) {
    return pathname(path).endsWith('/chat/completions');
  },

  parseRequest(record) {
    const body = asRecord(record.requestBody);
    const messages = asArray(body?.messages);
    const tools = asArray(body?.tools);
    const { system, history } = splitMessages(messages);

    return {
      provider: 'openai',
      kind: classify(tools.length, history.length, maxTokens(body)),
      agent: detectAgent(record.requestHeaders),
      model: asString(body?.model),
      sessionId: readSessionId(record.requestHeaders),
      systemFp: fingerprint('system', system),
      system,
      history,
    };
  },

  inspectRequest(record) {
    const body = asRecord(record.requestBody);
    if (!body) return undefined;
    const messages = asArray(body.messages);
    const tools = asArray(body.tools);
    return {
      summary: [
        { label: 'model', value: asString(body.model) ?? '—' },
        { label: 'messages', value: String(messages.length) },
        { label: 'tools', value: String(tools.length) },
        { label: 'max tokens', value: String(maxTokens(body) ?? '—') },
        { label: 'stream', value: String(body.stream ?? false) },
      ],
      toolNames: tools.map((tool) => toolName(tool) ?? '?'),
      // Only the leading messages are read. `splitMessages` would rebuild the
      // whole transcript as history items to hand back one string, on a body
      // that routinely runs to hundreds of kilobytes.
      systemText: readSystemPrompt(messages).system,
      bodyFields: {
        // The prompt is not a field of its own here — it is the first entries of
        // `messages`. Naming `messages` is what the Inspector's drill-down
        // needs: expand the array the prompt is actually inside.
        ...(Array.isArray(body.messages)
          ? { system: 'messages', history: 'messages' }
          : {}),
        ...(Array.isArray(body.tools) ? { tools: 'tools' } : {}),
      },
    };
  },

  parseStreamFrames(frames) {
    const events: StreamBlockEvent[] = [];
    for (const frame of frames) {
      const data = asRecord(frame.data);
      // `[DONE]` is not JSON, so it never parses into a record.
      if (!data) continue;

      // The `stream_options.include_usage` chunk: usage and no choices. Every
      // other chunk carries the same field explicitly set to null, so presence
      // alone does not mean a report has arrived.
      if (data.usage !== undefined && data.usage !== null) {
        events.push({ type: 'message_delta', usage: readUsage(data.usage), t: frame.t });
      }

      for (const raw of asArray(data.choices)) {
        const choice = asRecord(raw);
        if (!choice) continue;
        const index = numberOrUndefined(choice.index) ?? 0;
        const delta = asRecord(choice.delta) ?? {};

        // The role appears exactly once per choice, on its opening chunk, and
        // is the protocol's only marker for "a message starts here".
        if (delta.role !== undefined) {
          events.push({
            type: 'message_start',
            model: asString(data.model),
            t: frame.t,
          });
          events.push({
            type: 'block_start',
            index: blockIndex(index, TEXT_SLOT),
            kind: 'assistant',
            text: readContent(delta.content),
            t: frame.t,
          });
          const reasoning = readReasoning(delta);
          if (reasoning !== undefined) {
            events.push({
              type: 'block_start',
              index: blockIndex(index, REASONING_SLOT),
              kind: 'thinking',
              text: reasoning,
              t: frame.t,
            });
          }
        } else {
          const text = readContent(delta.content);
          if (text) {
            events.push({
              type: 'block_delta',
              index: blockIndex(index, TEXT_SLOT),
              text,
              t: frame.t,
            });
          }
          const reasoning = readReasoning(delta);
          if (reasoning) {
            events.push({
              type: 'block_delta',
              index: blockIndex(index, REASONING_SLOT),
              text: reasoning,
              t: frame.t,
            });
          }
        }

        const stoppedTools: number[] = [];
        for (const rawCall of asArray(delta.tool_calls)) {
          const call = asRecord(rawCall);
          if (!call) continue;
          const slot = TOOL_SLOT + (numberOrUndefined(call.index) ?? 0);
          const fn = asRecord(call.function);
          stoppedTools.push(slot);
          // `id` and `name` ride the call's first chunk only; every later one
          // carries nothing but the next slice of the argument JSON.
          if (call.id !== undefined) {
            events.push({
              type: 'block_start',
              index: blockIndex(index, slot),
              kind: 'tool_call',
              toolName: asString(fn?.name),
              toolUseId: asString(call.id),
              t: frame.t,
            });
            const opening = asString(fn?.arguments);
            if (opening) {
              events.push({
                type: 'block_delta',
                index: blockIndex(index, slot),
                text: opening,
                t: frame.t,
              });
            }
            continue;
          }
          const args = asString(fn?.arguments);
          if (args) {
            events.push({
              type: 'block_delta',
              index: blockIndex(index, slot),
              text: args,
              t: frame.t,
            });
          }
        }

        const finish = asString(choice.finish_reason);
        if (!finish) continue;
        // Close what this batch can see. Anything opened in an earlier batch —
        // a tool call whose last argument chunk arrived before this one — is
        // closed by the builder when the exchange completes, so no block is
        // left unfinalised and none is finalised twice.
        for (const slot of [TEXT_SLOT, REASONING_SLOT, ...stoppedTools]) {
          events.push({ type: 'block_stop', index: blockIndex(index, slot), t: frame.t });
        }
        events.push({ type: 'message_delta', stopReason: finish, t: frame.t });
      }
    }
    return events;
  },

  parseResponseBody(record) {
    const t = record.timing.endedAt ?? Date.now();
    const body = asRecord(record.responseBody);
    if (!body) return [];

    if (body.error !== undefined) {
      const error = asRecord(body.error);
      return [
        {
          type: 'error',
          error: `${asString(error?.type) ?? asString(error?.code) ?? 'error'}: ${
            asString(error?.message) ?? 'unknown'
          }`,
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

    let stopReason: string | undefined;
    for (const raw of asArray(body.choices)) {
      const choice = asRecord(raw);
      const message = asRecord(choice?.message);
      if (!message) continue;
      const index = numberOrUndefined(choice?.index) ?? 0;
      stopReason = asString(choice?.finish_reason) ?? stopReason;

      const emit = (event: Omit<StreamBlockEvent, 'type' | 't'>) => {
        events.push({ ...event, type: 'block_start', t });
        events.push({ type: 'block_stop', index: event.index, t });
      };

      // Same order the stream produces, so a captured non-streaming turn and a
      // streamed one fingerprint into the same transcript.
      const reasoning = readReasoning(message);
      if (reasoning?.trim()) {
        emit({ index: blockIndex(index, REASONING_SLOT), kind: 'thinking', text: reasoning });
      }
      const text = readContent(message.content);
      if (text.trim()) {
        emit({ index: blockIndex(index, TEXT_SLOT), kind: 'assistant', text });
      }
      asArray(message.tool_calls).forEach((rawCall, position) => {
        const call = asRecord(rawCall);
        if (!call) return;
        const fn = asRecord(call.function);
        const slot = TOOL_SLOT + (numberOrUndefined(call.index) ?? position);
        emit({
          index: blockIndex(index, slot),
          kind: 'tool_call',
          toolName: asString(fn?.name),
          toolUseId: asString(call.id),
          toolInput: readArguments(fn?.arguments),
        });
      });
    }

    events.push({
      type: 'message_delta',
      ...(stopReason !== undefined ? { stopReason } : {}),
      usage: readUsage(body.usage),
      t,
    });
    return events;
  },

  /**
   * No runtime on this protocol has a subagent convention to recognise. Naming
   * a tool here would guess on the user's behalf — a tool called `task` in
   * someone's own agent is an ordinary tool, and nesting its trace under the
   * caller would be an invented relationship.
   */
  isSubagentTool() {
    return false;
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

/** A side call is given barely any room to answer; a real turn is not. */
const UTILITY_MAX_TOKENS = 1024;

/**
 * Which requests belong in the Chat Trace — the same rule the Anthropic adapter
 * applies, for the same reason: an agent turn ships its tools, and a tool-less
 * request is only a side call when it is also short and given no room to reply.
 */
function classify(toolCount: number, messageCount: number, maxTokens: unknown) {
  if (toolCount > 0) return 'conversation' as const;
  const budget = typeof maxTokens === 'number' ? maxTokens : Number.POSITIVE_INFINITY;
  if (messageCount <= 1 && budget <= UTILITY_MAX_TOKENS) return 'utility' as const;
  return 'conversation' as const;
}

/** `max_completion_tokens` is the current name; `max_tokens` is the legacy one. */
function maxTokens(body: Record<string, unknown> | undefined): number | undefined {
  return numberOrUndefined(body?.max_completion_tokens) ?? numberOrUndefined(body?.max_tokens);
}

/**
 * The run id, when the runtime sends one. Codex puts its own on every call, and
 * the trace builder treats it as a precondition for continuing a conversation
 * rather than as a hint — which is exactly what it is worth.
 */
function readSessionId(headers: Record<string, string>): string | undefined {
  const id = headers['session_id'] ?? headers['x-session-id'];
  return id && id.trim() ? id : undefined;
}

function detectAgent(headers: Record<string, string>): string {
  const ua = (headers['user-agent'] ?? '').toLowerCase();
  const originator = (headers['originator'] ?? '').toLowerCase();
  if (ua.includes('codex') || originator.includes('codex')) return 'codex';
  if (ua.includes('mastra')) return 'mastra';
  if (ua.includes('openai')) return 'openai-sdk';
  return 'unknown';
}

/**
 * Lifts the request's system prompt out of the message list.
 *
 * Only the *leading* run of system/developer messages counts. One appearing
 * later in a transcript is a message in the conversation — some runtimes
 * re-inject instructions mid-run — and it stays in the history as a
 * system-role node, exactly as an Anthropic system-role message does.
 */
function readSystemPrompt(messages: readonly unknown[]): { system?: string; start: number } {
  const prompt: string[] = [];
  let start = 0;
  for (; start < messages.length; start++) {
    const message = asRecord(messages[start]);
    const role = asString(message?.role);
    if (role !== 'system' && role !== 'developer') break;
    const text = readContent(message?.content);
    if (text.trim()) prompt.push(text);
  }
  return { ...(prompt.length > 0 ? { system: prompt.join('\n\n') } : {}), start };
}

function splitMessages(messages: readonly unknown[]): {
  system?: string;
  history: HistoryItem[];
} {
  const { system, start } = readSystemPrompt(messages);
  return {
    ...(system !== undefined ? { system } : {}),
    history: messages.slice(start).flatMap(readMessage),
  };
}

/** One provider message becomes zero or more history items, one per block. */
function readMessage(raw: unknown): HistoryItem[] {
  const message = asRecord(raw);
  if (!message) return [];
  const role = asString(message.role);

  if (role === 'tool' || role === 'function') {
    const id = asString(message.tool_call_id) ?? '';
    return [
      {
        fp: fpToolResult(id, message.content),
        kind: 'tool_result',
        toolUseId: id,
        toolResult: message.content,
      },
    ];
  }

  const text = readContent(message.content);

  if (role === 'assistant') {
    const items: HistoryItem[] = [];
    const reasoning = readReasoning(message);
    if (reasoning?.trim()) items.push({ fp: fpThinking(reasoning), kind: 'thinking', text: reasoning });
    if (text.trim()) items.push({ fp: fpAssistant(text), kind: 'assistant', text });
    asArray(message.tool_calls).forEach((rawCall) => {
      const call = asRecord(rawCall);
      if (!call) return;
      const fn = asRecord(call.function);
      const id = asString(call.id) ?? '';
      const name = asString(fn?.name) ?? '';
      const input = readArguments(fn?.arguments);
      items.push({
        fp: fpToolCall(id, name, input),
        kind: 'tool_call',
        toolUseId: id,
        toolName: name,
        toolInput: input,
      });
    });
    return items;
  }

  if (!text.trim()) return [];

  if (role === 'system' || role === 'developer') {
    return [
      {
        fp: fpSystemText(text),
        kind: 'system',
        text,
        segments: [{ kind: 'system', systemSource: 'message', text }],
      },
    ];
  }

  const attachments = attachmentSignature(message.content);
  return [
    {
      // Keep the fingerprint on the original provider message; segmentation is
      // display only, exactly as on the Anthropic side.
      //
      // Attachments are folded in separately because they do not survive
      // `readContent`: every image collapses to the same `[image_url]` marker,
      // so two messages that are nothing but different screenshots would
      // fingerprint identically and the prefix match would call them the same
      // block.
      fp: attachments ? fingerprint('user', text, attachments) : fpUser(text),
      kind: 'user',
      text,
      segments: splitTaggedUserContent(text),
    },
  ];
}

/**
 * Identifies the non-text parts of a message without hashing their payloads.
 *
 * An inline image arrives as a data URL that can run to megabytes, and every
 * request replays the entire transcript — hashing them whole would re-hash the
 * same attachment on every turn, on the path that forwards the agent's request.
 * Media type, length and both ends separate any two attachments a session
 * actually holds, which is all a fingerprint has to do here.
 *
 * Returns undefined for ordinary text messages, so their fingerprints are
 * exactly what they were before attachments were considered at all.
 */
function attachmentSignature(content: unknown): unknown[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map(asRecord)
    .filter((part): part is Record<string, unknown> => part !== undefined)
    .filter((part) => asString(part.text) === undefined);
  if (parts.length === 0) return undefined;
  return parts.map((part) => {
    const payload =
      asString(asRecord(part.image_url)?.url) ??
      asString(asRecord(part.input_audio)?.data) ??
      asString(asRecord(part.file)?.file_data) ??
      '';
    return [
      asString(part.type) ?? 'part',
      payload.length,
      payload.slice(0, 64),
      payload.slice(-64),
    ];
  });
}

/**
 * Message content, which is a string on the simple path and a parts array once
 * anything non-textual is involved.
 *
 * A part with no text of its own — an image, an audio clip, a file — is kept as
 * a `[type]` marker rather than dropped: the transcript has to show that
 * *something* was sent there, and the fingerprint has to change when it does.
 */
function readContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((raw) => {
      const part = asRecord(raw);
      const text = asString(part?.text);
      if (text !== undefined) return text;
      const type = asString(part?.type);
      return type ? `[${type}]` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Reasoning text, where a model exposes it.
 *
 * OpenAI's own o-series does not return its reasoning over this API, but every
 * OpenAI-compatible server that does has settled on one of these two field
 * names, and reading them costs nothing when they are absent.
 */
function readReasoning(source: Record<string, unknown>): string | undefined {
  return asString(source.reasoning_content) ?? asString(source.reasoning);
}

/**
 * Tool arguments, parsed.
 *
 * On the wire they are a JSON *string*, while the streaming path reassembles
 * fragments and hands the builder a parsed object. Parsing here is what makes
 * a replayed tool call fingerprint identically to the one we watched stream —
 * without it, no request after a tool call would ever match its conversation.
 * Text that does not parse is kept verbatim, which is still stable.
 */
function readArguments(value: unknown): unknown {
  const text = asString(value);
  if (text === undefined) return value;
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toolName(tool: unknown): string | undefined {
  const record = asRecord(tool);
  return asString(asRecord(record?.function)?.name) ?? asString(record?.name);
}

function readUsage(raw: unknown): TokenUsage | undefined {
  const usage = asRecord(raw);
  if (!usage) return undefined;
  const promptDetails = asRecord(usage.prompt_tokens_details);
  const out: TokenUsage = {
    inputTokens: numberOrUndefined(usage.prompt_tokens),
    outputTokens: numberOrUndefined(usage.completion_tokens),
    // The API reports cache *reads* only; there is no creation counter to map.
    cacheReadInputTokens: numberOrUndefined(promptDetails?.cached_tokens),
  };
  return Object.values(out).some((value) => value !== undefined) ? out : undefined;
}
