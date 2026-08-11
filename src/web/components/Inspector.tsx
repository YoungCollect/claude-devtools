import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, type TransportDetail } from '../api.js';
import { formatBytes, formatClock, formatMs, formatTokens, pretty, truncate } from '../format.js';
import { hasXmlStructure } from '../../core/xml-outline.js';
import type { SseFrame, TraceNode } from '../../core/types.js';
import { focusBodyField } from '../inspect-focus.js';
import { ContentToolbar } from './ContentToolbar.js';
import { ContentViewer, type ContentFormat } from './ContentViewer.js';
import { JsonBodyViewer } from './JsonBodyViewer.js';
import {
  Badge,
  Button,
  CodeBlock,
  cx,
  Empty,
  KeyValue,
  Section,
  tabPanelProps,
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

const INSPECTOR_DRAWER_STYLE: CSSProperties & Record<'--drawer-content-width', string> = {
  '--drawer-content-width': 'max(440px, 46%)',
};

export interface InspectorProps {
  /** The request under inspection; `undefined` closes the drawer. */
  transportId?: string;
  /** The trace node the user drilled down from, when there is one. */
  focusNode?: TraceNode;
  rev: number;
  onClose: () => void;
}

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
    >
      <DrawerContent
        aria-label="Request inspector"
        className="border-hairline bg-canvas"
        style={INSPECTOR_DRAWER_STYLE}
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
  const [tab, setTab] = useState<TabId>(focusNode ? 'payload' : 'overview');
  const [reveal, setReveal] = useState(false);
  const [record, setRecord] = useState<TransportDetail | undefined>();

  // Arriving from a trace node is a question about the request body, so the
  // drawer opens on Payload rather than on the overview. Keyed on the node id,
  // not the node: the trace refetches its nodes on every store revision, and
  // re-running this on each streamed frame would drag the user back off
  // whichever tab they had moved to.
  const focusNodeId = focusNode?.id;
  useEffect(() => {
    if (focusNodeId !== undefined) setTab('payload');
  }, [focusNodeId]);

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
        <Tabs tabs={TABS} active={tab} onChange={setTab} idPrefix="inspector" label="Request detail" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" {...tabPanelProps('inspector', tab)}>
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
      return <Payload record={record} focusNode={focusNode} />;
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

function Payload({ record, focusNode }: { record: TransportDetail; focusNode?: TraceNode }) {
  const inspection = record.requestInspection;
  const systemText = inspection?.systemText;
  const systemFormats = useMemo<ContentFormat[]>(
    () =>
      systemText !== undefined && hasXmlStructure(systemText)
        ? ['markdown', 'xml']
        : ['markdown'],
    [systemText],
  );

  // The drill-down's payoff: the body opens on the one field the trace node
  // came out of, one level deep. Anything more and clicking a system prompt
  // would unroll every block inside it, which is the wall of JSON the fold was
  // there to avoid.
  const focusField = focusBodyField(focusNode, inspection?.bodyFields);
  const focusNodeId = focusNode?.id;
  // One text for both controls: what the diff captures is what Copy hands you.
  // Copy used to fall back to an empty string where the diff fell back to the
  // pretty-printed body, so a body the proxy had not kept verbatim copied
  // nothing at all.
  const bodyText = record.requestBodyRaw ?? pretty(record.requestBody);
  const [bodyOpen, setBodyOpen] = useState(false);
  useEffect(() => {
    if (focusNodeId !== undefined) setBodyOpen(true);
  }, [focusNodeId, focusField]);

  return (
    <>
      {inspection && (
        <Section title="Summary" defaultOpen={false}>
          <KeyValue
            rows={inspection.summary.map(({ label, value }) => [label, value])}
          />
        </Section>
      )}

      <Section
        title="Body"
        action={
          <ContentToolbar
            variant="inline"
            text={bodyText}
            copyLabel="Copy JSON"
            diff={{
              source: {
                sourceId: `${record.id}:request-body`,
                sessionId: record.conversationId ?? 'no-session',
                label: 'request body',
              },
              format: 'json',
            }}
          />
        }
        open={bodyOpen}
        onOpenChange={setBodyOpen}
      >
        <JsonBodyViewer
          value={record.requestBody}
          raw={record.requestBodyRaw}
          expandFields={focusField !== undefined ? [focusField] : undefined}
        />
      </Section>

      {inspection?.systemText !== undefined && (
        <Section title="System prompt" defaultOpen={false}>
          {/* Rendered only, like the rest of the app: Copy hands you the exact
              source, so the toggle was a second route to bytes you can already
              take. The Raw tab shows the whole request verbatim if that is what
              you are after.

              The control row stays where `ContentViewer` puts it by default —
              in this panel's own header, always visible. The Chat Trace moves
              its row below the bubble and reveals it on hover because a turn is
              something you read; a system prompt is something you audit, and
              its controls are part of that task rather than an interruption. */}
          <ContentViewer
            text={inspection.systemText}
            formats={systemFormats}
            showViewModes={false}
            diffSource={{
              sourceId: `${record.id}:system-prompt`,
              sessionId: record.conversationId ?? 'no-session',
              label: 'system prompt',
            }}
          />
        </Section>
      )}

      {/* The declared tool set is its own module, not a footnote under Summary.
          It is the longest thing on this tab for an agent with 20 tools, and
          folding it away independently is the whole reason it moved out. */}
      {inspection && (
        <Section title="Tools" defaultOpen={false}>
          {inspection.toolNames.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {inspection.toolNames.map((toolName, i) => (
                <Badge key={i} tone="tool">
                  {toolName}
                </Badge>
              ))}
            </div>
          ) : (
            <Empty>No tools declared on this request</Empty>
          )}
        </Section>
      )}
    </>
  );
}

function Response({ record }: { record: TransportDetail }) {
  const assembled = formatAssembledResponse(record.assembledResponse);
  const bodyText = record.responseBodyRaw ?? pretty(record.responseBody);

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
        <ContentToolbar
          variant="inline"
          text={bodyText}
          copyLabel="Copy JSON"
          diff={{
            source: {
              sourceId: `${record.id}:response-body`,
              sessionId: record.conversationId ?? 'no-session',
              label: 'response body',
            },
            format: 'json',
          }}
        />
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
      <div className="overflow-hidden rounded-lg border border-code-border bg-code">
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
        <pre className="mt-1.5 overflow-x-auto rounded-md border border-code-border bg-code-soft p-3 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap text-code-fg">
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
  const rawRequest = record.requestBodyRaw ?? '';
  const rawResponse = record.isStream ? rawStream : (record.responseBodyRaw ?? '');
  // No diff selection here on purpose: this tab shows the bytes exactly as they
  // arrived, and the Payload/Response tabs already offer the same bodies as
  // diffable JSON. Copy is the whole control.
  return (
    <>
      <Section
        title="Request body (raw)"
        action={<ContentToolbar variant="inline" text={rawRequest} copyLabel="Copy raw request" />}
        defaultOpen={false}
      >
        <CodeBlock text={rawRequest} />
      </Section>
      <Section
        title={record.isStream ? 'Response stream (raw SSE)' : 'Response body (raw)'}
        action={
          <ContentToolbar
            variant="inline"
            text={rawResponse}
            copyLabel={record.isStream ? 'Copy raw SSE stream' : 'Copy raw response'}
          />
        }
      >
        <CodeBlock text={rawResponse} />
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
