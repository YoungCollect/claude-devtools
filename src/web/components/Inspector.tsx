import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, type TransportDetail } from '../api.js';
import { formatBytes, formatClock, formatMs, formatTokens, pretty, truncate } from '../format.js';
import { hasXmlStructure } from '../../core/xml-outline.js';
import type { SseFrame, TraceNode } from '../../core/types.js';
import { ContentViewer, type ContentFormat } from './ContentViewer.js';
import { JsonBodyViewer } from './JsonBodyViewer.js';
import { DiffSourceButtons } from './DiffSourceButtons.js';
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
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from './ui/drawer.js';

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
  /** The request under inspection; `undefined` closes the drawer. */
  transportId?: string;
  /** The trace node the user drilled down from, when there is one. */
  focusNode?: TraceNode;
  rev: number;
  onClose: () => void;
}

/**
 * How much horizontal room the open drawer needs.
 *
 * Exported because the app shell reserves exactly this much padding while the
 * drawer is open. The drawer itself is `position: fixed`, so without that
 * reservation it would sit *on top of* the Network table and the header
 * controls rather than beside them — and reading a request while comparing it
 * against the rows behind it is the point of the panel.
 */
export const INSPECTOR_WIDTH = 'max(440px, 46%)';

/**
 * The drawer shell.
 *
 * It is deliberately *non-modal* and not dismissed by outside presses: the whole
 * point of this panel is to read a request while clicking the next row in the
 * Chat Trace or Network list behind it. A modal drawer would make picking the
 * next request a close-then-reopen round trip. Escape and the ✕ still close it.
 */
export function Inspector({ transportId, focusNode, rev, onClose }: InspectorProps) {
  // The selection is cleared the moment the user closes the drawer, but the
  // panel is still on screen sliding out. Holding the last request here keeps it
  // rendered until the close animation actually finishes.
  const [shown, setShown] = useState<{ transportId: string; focusNode?: TraceNode }>();

  useEffect(() => {
    if (transportId !== undefined) setShown({ transportId, focusNode });
  }, [transportId, focusNode]);

  return (
    <Drawer
      open={transportId !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) setShown(undefined);
      }}
      swipeDirection="right"
      modal={false}
      disablePointerDismissal
    >
      <DrawerContent
        aria-label="Request inspector"
        className="border-hairline bg-canvas"
        // The popup sizes itself from this variable. Setting it inline rather
        // than through a `w-*` utility keeps the drawer's own responsive width
        // rules from winning on specificity.
        style={{ '--drawer-content-width': INSPECTOR_WIDTH } as CSSProperties}
      >
        {shown && <InspectorPanel transportId={shown.transportId} focusNode={shown.focusNode} rev={rev} />}
      </DrawerContent>
    </Drawer>
  );
}

function InspectorPanel({
  transportId,
  focusNode,
  rev,
}: {
  transportId: string;
  focusNode?: TraceNode;
  rev: number;
}) {
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
    <>
      <header className="flex shrink-0 items-center gap-2.5 border-b border-hairline px-4 py-3">
        <DrawerTitle className="font-mono text-[12.5px] font-normal text-body">
          {record ? `${record.method} ${truncate(record.path, 36)}` : 'loading…'}
        </DrawerTitle>
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
          <DrawerClose
            className="px-1 text-muted-foreground hover:text-ink"
            aria-label="Close inspector"
          >
            ✕
          </DrawerClose>
        </div>
      </header>

      <div className="shrink-0 border-b border-hairline py-2">
        <Tabs tabs={TABS} active={tab} onChange={setTab} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!record ? (
          <Empty>Request not found — it may have been evicted from the buffer.</Empty>
        ) : (
          <TabBody tab={tab} record={record} focusNode={focusNode} />
        )}
      </div>
    </>
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
        <p className="mt-3 text-[13px] leading-[1.55] text-muted-foreground">
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
  const inspection = record.requestInspection;
  const systemText = inspection?.systemText;
  const systemFormats = useMemo<ContentFormat[]>(
    () =>
      systemText !== undefined && hasXmlStructure(systemText)
        ? ['markdown', 'xml']
        : ['markdown'],
    [systemText],
  );

  return (
    <>
      {inspection && (
        <Section title="Summary">
          <KeyValue
            rows={inspection.summary.map(({ label, value }) => [label, value])}
          />
          {inspection.toolNames.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {inspection.toolNames.map((toolName, i) => (
                <Badge key={i} tone="tool">
                  {toolName}
                </Badge>
              ))}
            </div>
          )}
        </Section>
      )}

      {inspection?.systemText !== undefined && (
        <Section title="System prompt" defaultOpen={false}>
          {/* System prompts are markdown that also carries tag blocks, so both
              rendered views are offered alongside the source. */}
          <ContentViewer
            text={inspection.systemText}
            formats={systemFormats}
            diffSource={{
              sourceId: `${record.id}:system-prompt`,
              sessionId: record.conversationId ?? 'no-session',
              label: 'system prompt',
            }}
          />
        </Section>
      )}

      <Section
        title="Body"
        action={
          <div className="flex items-center gap-1.5">
            <DiffSourceButtons
              source={{
                sourceId: `${record.id}:request-body`,
                sessionId: record.conversationId ?? 'no-session',
                label: 'request body',
                text: record.requestBodyRaw ?? pretty(record.requestBody),
                format: 'json',
              }}
            />
            <CopyButton text={record.requestBodyRaw ?? ''} label="Copy JSON" />
          </div>
        }
        defaultOpen={inspection?.systemText === undefined}
      >
        <JsonBodyViewer value={record.requestBody} raw={record.requestBodyRaw} />
      </Section>
    </>
  );
}

function Response({ record }: { record: TransportDetail }) {
  const assembled = formatAssembledResponse(record.assembledResponse);

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
    <Section
      title="Body"
      action={
        <div className="flex items-center gap-1.5">
          <DiffSourceButtons
            source={{
              sourceId: `${record.id}:response-body`,
              sessionId: record.conversationId ?? 'no-session',
              label: 'response body',
              text: record.responseBodyRaw ?? pretty(record.responseBody),
              format: 'json',
            }}
          />
          <CopyButton text={record.responseBodyRaw ?? ''} label="Copy" />
        </div>
      }
    >
      <JsonBodyViewer value={record.responseBody} raw={record.responseBodyRaw} />
    </Section>
  );
}

function Stream({ record }: { record: TransportDetail }) {
  const start = record.timing.startedAt;
  const frames = record.sseFrames;

  if (record.sseFrames.length === 0) return <Empty>Not a streaming response.</Empty>;

  return (
    <div className="p-4">
      <div className="mb-3 text-[13px] text-muted-foreground">
        {frames.length} raw frames
      </div>
      <div className="overflow-hidden rounded-lg bg-code">
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
      <div className="mb-1 flex justify-between text-[12.5px] text-muted-foreground">
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

function formatAssembledResponse(response: TransportDetail['assembledResponse']): string {
  if (!response) return '';
  const parts = response.blocks.map((block) => {
    const header = `── [${block.index}] ${block.kind}${block.name ? ` · ${block.name}` : ''} ──`;
    return `${header}\n${block.text}`;
  });
  if (response.stopReason) parts.push(`── stop_reason ──\n${response.stopReason}`);
  return parts.join('\n\n');
}
