import { useEffect, useMemo, useState } from 'react';
import { api, type TransportDetail } from '../api.js';
import { formatBytes, formatClock, formatMs, formatTokens, pretty, truncate } from '../format.js';
import type { SseFrame, TraceNode } from '../../core/types.js';
import {
  Badge,
  Button,
  CodeBlock,
  CopyButton,
  cx,
  Empty,
  KeyValue,
  Section,
  Tabs,
} from './ui.js';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'headers', label: 'Headers' },
  { id: 'payload', label: 'Payload' },
  { id: 'response', label: 'Response' },
  { id: 'stream', label: 'SSE' },
  { id: 'timing', label: 'Timing' },
  { id: 'raw', label: 'Raw' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export interface InspectorProps {
  transportId: string;
  /** The trace node the user drilled down from, when there is one. */
  focusNode?: TraceNode;
  rev: number;
  onClose: () => void;
}

export function Inspector({ transportId, focusNode, rev, onClose }: InspectorProps) {
  const [tab, setTab] = useState<TabId>('overview');
  const [reveal, setReveal] = useState(false);
  const [record, setRecord] = useState<TransportDetail | undefined>();

  useEffect(() => {
    let cancelled = false;
    api
      .transport(transportId, reveal)
      .then(({ record: next }) => {
        if (!cancelled) setRecord(next);
      })
      .catch(() => {
        if (!cancelled) setRecord(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [transportId, reveal, rev]);

  return (
    <aside className="flex h-full w-[46%] min-w-[440px] flex-col border-l border-hairline bg-canvas">
      <header className="flex items-center gap-2.5 border-b border-hairline px-4 py-3">
        <span className="font-mono text-[12.5px] text-body">
          {record ? `${record.method} ${truncate(record.path, 36)}` : 'loading…'}
        </span>
        {record?.status !== undefined && (
          <Badge tone={record.status >= 400 ? 'error' : 'success'}>{record.status}</Badge>
        )}
        {record?.isStream && <Badge tone="emph">stream</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <Button
            onClick={() => setReveal((v) => !v)}
            active={reveal}
            title="Reveal credentials in headers"
          >
            {reveal ? 'secrets shown' : 'secrets masked'}
          </Button>
          <button
            type="button"
            onClick={onClose}
            className="px-1 text-muted hover:text-ink"
            aria-label="Close inspector"
          >
            ✕
          </button>
        </div>
      </header>

      <div className="border-b border-hairline py-2">
        <Tabs tabs={TABS} active={tab} onChange={setTab} />
      </div>

      <div className="flex-1 overflow-y-auto">
        {!record ? (
          <Empty>Request not found — it may have been evicted from the buffer.</Empty>
        ) : (
          <TabBody tab={tab} record={record} focusNode={focusNode} />
        )}
      </div>
    </aside>
  );
}

function TabBody({
  tab,
  record,
  focusNode,
}: {
  tab: TabId;
  record: TransportDetail;
  focusNode?: TraceNode;
}) {
  switch (tab) {
    case 'overview':
      return <Overview record={record} focusNode={focusNode} />;
    case 'headers':
      return <Headers record={record} />;
    case 'payload':
      return <Payload record={record} />;
    case 'response':
      return <Response record={record} />;
    case 'stream':
      return <Stream record={record} />;
    case 'timing':
      return <Timing record={record} />;
    case 'raw':
      return <Raw record={record} />;
  }
}

function Overview({ record, focusNode }: { record: TransportDetail; focusNode?: TraceNode }) {
  const t = record.derivedTiming;
  return (
    <>
      {focusNode && (
        <Section title="Selected trace node">
          <KeyValue
            rows={[
              ['kind', focusNode.kind],
              ...(focusNode.toolName ? ([['tool', focusNode.toolName]] as [string, string][]) : []),
              [
                'origin',
                focusNode.producedByRequestId
                  ? 'streamed back in this response'
                  : 'revealed by this request’s history',
              ],
              ['at', formatClock(focusNode.ts)],
              ...(focusNode.durationMs !== undefined
                ? ([
                    [
                      focusNode.kind === 'tool_result' ? 'tool time' : 'block time',
                      formatMs(focusNode.durationMs) +
                        (focusNode.durationIsBatch ? ' (parallel batch)' : ''),
                    ],
                  ] as [string, string][])
                : []),
            ]}
          />
        </Section>
      )}

      <Section title="Request">
        <KeyValue
          rows={[
            ['method', record.method],
            ['path', record.path],
            ['upstream', record.url],
            ['provider', record.provider],
            ['kind', record.kind],
            ['model', record.model ?? '—'],
            [
              'status',
              record.status !== undefined ? `${record.status} ${record.statusText ?? ''}` : '—',
            ],
            ['stream', String(record.isStream)],
            ...(record.conversationId
              ? ([['turn', `#${(record.turnIndex ?? 0) + 1} of ${record.conversationId}`]] as [
                  string,
                  string,
                ][])
              : []),
            ...(record.error ? ([['error', record.error]] as [string, string][]) : []),
          ]}
        />
      </Section>

      <Section title="Tokens">
        {record.usage ? (
          <KeyValue
            rows={[
              ['input', formatTokens(record.usage.inputTokens)],
              ['output', formatTokens(record.usage.outputTokens)],
              ['cache read', formatTokens(record.usage.cacheReadInputTokens)],
              ['cache write', formatTokens(record.usage.cacheCreationInputTokens)],
            ]}
          />
        ) : (
          <Empty>No usage reported</Empty>
        )}
      </Section>

      <Section title="Size & timing">
        <KeyValue
          rows={[
            ['request', formatBytes(record.requestBytes)],
            ['response', formatBytes(record.responseBytes)],
            ['ttfb', formatMs(t.ttfbMs)],
            ['first token', formatMs(t.firstTokenMs)],
            ['total', formatMs(t.totalMs)],
            ['sse frames', String(t.frameCount)],
          ]}
        />
      </Section>
    </>
  );
}

function Headers({ record }: { record: TransportDetail }) {
  return (
    <>
      <Section title="Request headers">
        <HeaderTable headers={record.requestHeaders} />
        <p className="mt-3 text-[13px] leading-[1.55] text-muted">
          These are the headers the agent sent. The proxy forwards them unchanged except{' '}
          <code className="font-mono text-[12.5px] text-body-strong">accept-encoding</code>, which it
          rewrites to <code className="font-mono text-[12.5px] text-body-strong">identity</code> so
          response bodies stay readable.
        </p>
      </Section>
      <Section title="Response headers">
        {record.responseHeaders ? (
          <HeaderTable headers={record.responseHeaders} />
        ) : (
          <Empty>No response headers</Empty>
        )}
      </Section>
    </>
  );
}

function HeaderTable({ headers }: { headers: Record<string, string> }) {
  const rows = Object.entries(headers).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) return <Empty>None</Empty>;
  return <KeyValue rows={rows.map(([k, v]) => [k, v] as [string, string])} />;
}

function Payload({ record }: { record: TransportDetail }) {
  const body = record.requestBody as Record<string, unknown> | undefined;
  const messages = Array.isArray(body?.messages) ? body.messages : undefined;
  const tools = Array.isArray(body?.tools) ? body.tools : undefined;
  const system = body?.system;

  return (
    <>
      {body && (
        <Section title="Summary">
          <KeyValue
            rows={[
              ['model', String(body.model ?? '—')],
              ['messages', String(messages?.length ?? 0)],
              ['tools', String(tools?.length ?? 0)],
              ['max_tokens', String(body.max_tokens ?? '—')],
              ['stream', String(body.stream ?? false)],
            ]}
          />
          {tools && tools.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {tools.map((tool, i) => (
                <Badge key={i} tone="tool">
                  {String((tool as Record<string, unknown>)?.name ?? '?')}
                </Badge>
              ))}
            </div>
          )}
        </Section>
      )}

      {system !== undefined && (
        <Section title="System prompt" defaultOpen={false}>
          <CodeBlock text={typeof system === 'string' ? system : pretty(system)} />
        </Section>
      )}

      <Section
        title="Body"
        action={<CopyButton text={record.requestBodyRaw ?? ''} label="Copy JSON" />}
        defaultOpen={system === undefined}
      >
        <CodeBlock
          text={record.requestBody ? pretty(record.requestBody) : (record.requestBodyRaw ?? '')}
        />
      </Section>
    </>
  );
}

function Response({ record }: { record: TransportDetail }) {
  const assembled = useMemo(() => assembleStream(record.sseFrames), [record.sseFrames]);

  if (record.isStream) {
    return (
      <Section
        title="Assembled response"
        action={<Badge tone="emph">{record.sseFrames.length} frames</Badge>}
      >
        {assembled ? (
          <CodeBlock text={assembled} />
        ) : (
          <Empty>Nothing assembled yet — the stream is still open or carried no content.</Empty>
        )}
      </Section>
    );
  }

  return (
    <Section title="Body" action={<CopyButton text={record.responseBodyRaw ?? ''} label="Copy" />}>
      <CodeBlock
        text={record.responseBody ? pretty(record.responseBody) : (record.responseBodyRaw ?? '')}
      />
    </Section>
  );
}

function Stream({ record }: { record: TransportDetail }) {
  const [hideDeltas, setHideDeltas] = useState(true);
  const start = record.timing.startedAt;

  const frames = record.sseFrames.filter(
    (frame) => !hideDeltas || frame.event !== 'content_block_delta',
  );

  if (record.sseFrames.length === 0) return <Empty>Not a streaming response.</Empty>;

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2.5">
        <Button onClick={() => setHideDeltas((v) => !v)} active={hideDeltas}>
          {hideDeltas ? 'deltas hidden' : 'deltas shown'}
        </Button>
        <span className="text-[13px] text-muted">
          {frames.length} / {record.sseFrames.length} frames
        </span>
      </div>
      <div className="on-code overflow-hidden rounded-lg bg-code">
        <div className="divide-y divide-code-divider">
          {frames.slice(0, 800).map((frame, i) => (
            <FrameRow key={i} frame={frame} offsetMs={frame.t - start} />
          ))}
        </div>
      </div>
      {frames.length > 800 && (
        <div className="mt-2 text-[12px] text-muted-soft">
          showing first 800 frames of {frames.length}
        </div>
      )}
    </div>
  );
}

function FrameRow({ frame, offsetMs }: { frame: SseFrame; offsetMs: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-3 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-3 text-left"
      >
        <span className="w-16 shrink-0 text-right font-mono text-[12px] text-code-fg-soft">
          +{formatMs(offsetMs)}
        </span>
        <span className="w-48 shrink-0 truncate font-mono text-[12.5px] text-code-accent">
          {frame.event ?? '(no event)'}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-code-fg-soft">
          {truncate(frame.raw.replace(/\s+/g, ' '), 120)}
        </span>
      </button>
      {open && (
        <pre className="mt-1.5 overflow-x-auto rounded-md bg-code-soft p-3 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap text-code-fg">
          {frame.data ? pretty(frame.data) : frame.raw}
        </pre>
      )}
    </div>
  );
}

function Timing({ record }: { record: TransportDetail }) {
  const t = record.derivedTiming;
  const total = t.totalMs ?? 0;
  const scale = (ms: number | undefined) => (total > 0 && ms !== undefined ? (ms / total) * 100 : 0);

  return (
    <>
      <Section title="Waterfall">
        {total > 0 ? (
          <div className="space-y-3">
            <Bar
              label="wait (ttfb)"
              widthPct={scale(t.ttfbMs)}
              offsetPct={0}
              tone="bg-muted-soft"
              value={t.ttfbMs}
            />
            <Bar
              label="→ first token"
              widthPct={scale((t.firstTokenMs ?? 0) - (t.ttfbMs ?? 0))}
              offsetPct={scale(t.ttfbMs)}
              tone="bg-tool-fg"
              value={
                t.firstTokenMs !== undefined && t.ttfbMs !== undefined
                  ? t.firstTokenMs - t.ttfbMs
                  : undefined
              }
            />
            <Bar
              label="stream"
              widthPct={scale(t.streamMs)}
              offsetPct={scale(t.ttfbMs)}
              tone="bg-primary"
              value={t.streamMs}
            />
          </div>
        ) : (
          <Empty>Still in flight.</Empty>
        )}
      </Section>

      <Section title="Marks">
        <KeyValue
          rows={[
            ['started', formatClock(record.timing.startedAt)],
            ['headers', record.timing.ttfbAt ? formatClock(record.timing.ttfbAt) : '—'],
            [
              'first token',
              record.timing.firstTokenAt ? formatClock(record.timing.firstTokenAt) : '—',
            ],
            ['ended', record.timing.endedAt ? formatClock(record.timing.endedAt) : '—'],
          ]}
        />
      </Section>

      <Section title="Throughput">
        <KeyValue
          rows={[
            ['ttfb', formatMs(t.ttfbMs)],
            ['time to first token', formatMs(t.firstTokenMs)],
            ['stream duration', formatMs(t.streamMs)],
            ['total', formatMs(t.totalMs)],
            [
              'output tok/s',
              record.usage?.outputTokens && t.streamMs
                ? (record.usage.outputTokens / (t.streamMs / 1000)).toFixed(1)
                : '—',
            ],
          ]}
        />
      </Section>
    </>
  );
}

function Bar({
  label,
  widthPct,
  offsetPct,
  tone,
  value,
}: {
  label: string;
  widthPct: number;
  offsetPct: number;
  tone: string;
  value: number | undefined;
}) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-[12.5px] text-muted">
        <span>{label}</span>
        <span className="font-mono">{formatMs(value)}</span>
      </div>
      <div className="h-2 w-full rounded-full bg-surface-card">
        <div
          className={cx('h-2 rounded-full', tone)}
          style={{ marginLeft: `${offsetPct}%`, width: `${Math.max(widthPct, 0.5)}%` }}
        />
      </div>
    </div>
  );
}

function Raw({ record }: { record: TransportDetail }) {
  const rawStream = record.sseFrames.map((frame) => frame.raw).join('\n\n');
  return (
    <>
      <Section
        title="Request body (raw)"
        action={<CopyButton text={record.requestBodyRaw ?? ''} />}
        defaultOpen={false}
      >
        <CodeBlock text={record.requestBodyRaw ?? ''} />
      </Section>
      <Section
        title={record.isStream ? 'Response stream (raw SSE)' : 'Response body (raw)'}
        action={<CopyButton text={record.isStream ? rawStream : (record.responseBodyRaw ?? '')} />}
      >
        <CodeBlock text={record.isStream ? rawStream : (record.responseBodyRaw ?? '')} />
      </Section>
    </>
  );
}

/**
 * Rebuild the final message from the captured frames, so the Response tab can
 * show what the agent actually received instead of a wall of deltas.
 */
function assembleStream(frames: SseFrame[]): string {
  const blocks = new Map<number, { type: string; name?: string; text: string }>();
  let stopReason: string | undefined;

  for (const frame of frames) {
    const data = frame.data as Record<string, unknown> | undefined;
    if (!data) continue;
    const index = typeof data.index === 'number' ? data.index : undefined;

    if (data.type === 'content_block_start' && index !== undefined) {
      const block = data.content_block as Record<string, unknown> | undefined;
      blocks.set(index, {
        type: String(block?.type ?? 'text'),
        name: typeof block?.name === 'string' ? block.name : undefined,
        text: typeof block?.text === 'string' ? block.text : '',
      });
    } else if (data.type === 'content_block_delta' && index !== undefined) {
      const delta = data.delta as Record<string, unknown> | undefined;
      const chunk = delta?.text ?? delta?.thinking ?? delta?.partial_json;
      const block = blocks.get(index);
      if (block && typeof chunk === 'string') block.text += chunk;
    } else if (data.type === 'message_delta') {
      const delta = data.delta as Record<string, unknown> | undefined;
      if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason;
    }
  }

  const parts = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, block]) => {
      const header = `── [${index}] ${block.type}${block.name ? ` · ${block.name}` : ''} ──`;
      return `${header}\n${block.text}`;
    });
  if (stopReason) parts.push(`── stop_reason ──\n${stopReason}`);
  return parts.join('\n\n');
}
