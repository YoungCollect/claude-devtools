import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, subscribeToRevisions, type ServerConfig } from './api.js';
import type { StateSnapshot, TraceNode } from '../core/types.js';
import { ConversationList } from './components/ConversationList.js';
import { GitDiffDialog } from './components/GitDiffDialog.js';
import { Inspector } from './components/Inspector.js';
import { NetworkView } from './components/NetworkView.js';
import { TraceView } from './components/TraceView.js';
import {
  Badge,
  Button,
  cx,
  Empty,
  SpikeMark,
  tabPanelProps,
  Tabs,
  ThemeToggle,
  useCopy,
} from './components/ui.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { groupTrace } from './trace-groups.js';
import { useTheme } from './theme.js';
import { clearGitDiff, setGitDiffOpen } from './git-diff.js';
import { transportForConversation } from './transport.js';

const VIEWS = [
  { id: 'trace', label: 'Chat Trace' },
  { id: 'network', label: 'Network' },
] as const;

type ViewId = (typeof VIEWS)[number]['id'];

interface Selection {
  transportId: string;
  node?: TraceNode;
}

/**
 * Sub-pixel layout means a pane parked at the bottom rarely reports an exact
 * zero, and a row can grow by a hair between frames. Anything inside this much
 * of the end still counts as "reading the newest event".
 */
const BOTTOM_SLACK_PX = 48;

/**
 * Follows the newest trace event as a response streams in.
 *
 * Only while the reader is already at the bottom. Scrolling up to re-read an
 * earlier turn is deliberate, and a trace that yanked the viewport back down on
 * every frame would be unreadable for the whole length of a response — so the
 * pane stops following the moment you leave the end, and picks it up again when
 * you return.
 */
function useFollowNewest({
  content,
  resetKey,
  enabled,
}: {
  /** Changes whenever new content may have been appended. */
  content: unknown;
  /** Changing this jumps back to the end — a different trace starts at its end. */
  resetKey: unknown;
  enabled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
  }, []);

  // Declared before the scroll effect so that on a conversation switch — where
  // both fire — following is restored first and the new trace opens at its end.
  useLayoutEffect(() => {
    following.current = true;
  }, [resetKey]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled || !following.current) return;
    el.scrollTop = el.scrollHeight;
  }, [content, resetKey, enabled]);

  return { ref, onScroll };
}

export function App() {
  const [config, setConfig] = useState<ServerConfig | undefined>();
  const [snapshot, setSnapshot] = useState<StateSnapshot>({
    rev: 0,
    conversations: [],
    transport: [],
  });
  const [view, setView] = useState<ViewId>('trace');
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [nodes, setNodes] = useState<TraceNode[]>([]);
  const [selection, setSelection] = useState<Selection | undefined>();
  const [connected, setConnected] = useState(false);
  const { theme, toggle: toggleTheme } = useTheme();

  // `pinned` means the user picked a conversation explicitly; until then the UI
  // follows whatever trace is currently active, which is what you want when you
  // start the proxy and then go type in the terminal.
  const pinned = useRef(false);

  useEffect(() => {
    void api.config().then(setConfig).catch(() => undefined);
  }, []);

  const refresh = useCallback(async () => {
    const next = await api.state();
    setSnapshot(next);
    setConnected(true);
    return next;
  }, []);

  useEffect(() => {
    void refresh().catch(() => setConnected(false));
    return subscribeToRevisions(() => {
      void refresh().catch(() => setConnected(false));
    });
  }, [refresh]);

  // Follow the newest conversation until the user pins one.
  useEffect(() => {
    if (snapshot.conversations.length === 0) return;
    const latest = snapshot.conversations[snapshot.conversations.length - 1];
    if (!latest) return;
    const stillExists = snapshot.conversations.some((c) => c.id === conversationId);
    if (!conversationId || (!pinned.current && latest.id !== conversationId) || !stillExists) {
      setConversationId(latest.id);
    }
  }, [snapshot.conversations, conversationId]);

  useEffect(() => {
    if (!conversationId) {
      setNodes([]);
      return;
    }
    let cancelled = false;
    void api
      .nodes(conversationId)
      .then(({ nodes: next }) => {
        if (!cancelled) setNodes(next);
      })
      .catch(() => {
        if (!cancelled) setNodes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, snapshot.rev]);

  // A transport selection belongs to one conversation. Do not leave another
  // chat's Inspector open after the user switches the conversation scope.
  useEffect(() => {
    setSelection(undefined);
  }, [conversationId]);

  const inspectNode = useCallback((node: TraceNode) => {
    const transportId = node.producedByRequestId ?? node.revealedByRequestId;
    if (!transportId) return;
    setSelection({ transportId, node });
  }, []);

  const conversation = snapshot.conversations.find((c) => c.id === conversationId);
  const conversationTransport = transportForConversation(snapshot.transport, conversationId);

  // What the trace actually renders, so the tab badge and the Network badge
  // mean the same thing.
  const traceItemCount = useMemo(() => groupTrace(nodes).length, [nodes]);

  const trace = useFollowNewest({
    content: nodes,
    resetKey: conversationId,
    enabled: view === 'trace',
  });

  return (
    // One provider for the whole app, because the delay is a property of the
    // *set* of tooltips: after the first one opens, moving along a row of icon
    // controls shows the next immediately instead of re-serving the wait.
    <TooltipProvider delay={300}>
      <div className="flex h-full flex-col bg-canvas">
        <Header
          config={config}
          connected={connected}
          theme={theme}
          onToggleTheme={toggleTheme}
          onClear={async () => {
            clearGitDiff();
            // Rejects on failure so the button can show it; refreshing on a failed
            // clear would present unchanged data as if the wipe had worked.
            await api.clear();
            await refresh();
          }}
          onOpenDiff={() => setGitDiffOpen(true)}
        />

        <div className="flex min-h-0 flex-1">
          <nav className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-hairline">
            {/* h-12 on both this and the view tabs opposite it. Left to size
                themselves, the two bars derive different heights from different
                type scales (12px label vs 14px tab), and the rules that separate
                them from the content below stop meeting at the divider. */}
            <div className="flex h-12 shrink-0 items-center border-b border-hairline px-4 text-[12px] font-medium tracking-[1.5px] text-muted-foreground uppercase">
              Conversations
            </div>
            <ConversationList
              conversations={snapshot.conversations}
              selectedId={conversationId}
              onSelect={(id) => {
                pinned.current = true;
                setConversationId(id);
              }}
              onDelete={async (id) => {
                await api.deleteConversation(id);
                await refresh();
              }}
            />
          </nav>

          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-12 shrink-0 items-center border-b border-hairline">
              <Tabs
                tabs={[
                  // Both counts are "rows this view renders". `nodes.length` was
                  // the node total, which stopped matching the trace when a
                  // response and its tool round folded into one turn — and read as
                  // a different kind of number than the badge beside it. The node
                  // total is still on the conversation card in the sidebar.
                  { id: 'trace' as const, label: 'Chat Trace', count: traceItemCount },
                  { id: 'network' as const, label: 'Network', count: conversationTransport.length },
                ]}
                active={view}
                onChange={setView}
                idPrefix="view"
                label="Views"
              />
              {view === 'trace' && conversation && (
                <div className="ml-auto flex items-center gap-2 px-4">
                  <Badge tone="emph">{conversation.agent}</Badge>
                  <span className="font-mono text-[12.5px] text-muted-foreground">{conversation.model}</span>
                </div>
              )}
            </div>

            <div
              className="min-h-0 flex-1 overflow-y-auto"
              ref={trace.ref}
              onScroll={trace.onScroll}
              {...tabPanelProps('view', view)}
            >
              {view === 'trace' ? (
                conversation ? (
                  <TraceView nodes={nodes} selectedNodeId={selection?.node?.id} onInspect={inspectNode} />
                ) : (
                  <Empty>
                    Waiting for traffic. Start an agent with the proxy base URL shown above.
                  </Empty>
                )
              ) : (
                <NetworkView
                  transport={conversationTransport}
                  selectedId={selection?.transportId}
                  onSelect={(id) => setSelection({ transportId: id })}
                />
              )}
            </div>
          </main>
        </div>

        <Inspector
          transportId={selection?.transportId}
          focusNode={selection?.node}
          rev={snapshot.rev}
          onClose={() => setSelection(undefined)}
        />
        <GitDiffDialog theme={theme} />
      </div>
    </TooltipProvider>
  );
}

/**
 * Clear, behind the same two-step the far less destructive action already has.
 *
 * Deleting one conversation takes two deliberate acts — open its menu, then
 * confirm — and reports progress and failure. Clear wipes every conversation,
 * every trace and the database, cannot be undone, and sat one stray click away
 * between `Diff` and the theme toggle. The protection was inverted relative to
 * the damage.
 *
 * An in-place arm rather than a modal: it matches the weight of the existing
 * delete flow, and it disarms itself so a click you thought better of does not
 * stay loaded.
 */
const CLEAR_ARMED_MS = 4000;

function ClearButton({ onClear }: { onClear: () => Promise<void> | void }) {
  const [state, setState] = useState<'idle' | 'armed' | 'clearing' | 'failed'>('idle');

  useEffect(() => {
    if (state !== 'armed') return;
    const timer = setTimeout(() => setState('idle'), CLEAR_ARMED_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const label =
    state === 'clearing' ? 'Clearing…' : state === 'armed' ? 'Confirm clear' : state === 'failed' ? 'Retry clear' : 'Clear';

  return (
    <Button
      tone="danger"
      active={state === 'armed'}
      title={state === 'armed' ? 'Removes every trace from memory and disk' : 'Clear all captured traces'}
      onClick={() => {
        if (state === 'clearing') return;
        if (state !== 'armed') {
          setState('armed');
          return;
        }
        setState('clearing');
        void Promise.resolve(onClear()).then(
          () => setState('idle'),
          () => setState('failed'),
        );
      }}
    >
      {label}
    </Button>
  );
}

function Header({
  config,
  connected,
  theme,
  onToggleTheme,
  onClear,
  onOpenDiff,
}: {
  config: ServerConfig | undefined;
  connected: boolean;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onClear: () => Promise<void> | void;
  onOpenDiff: () => void;
}) {
  const command = config ? `ANTHROPIC_BASE_URL=${config.proxyUrl} claude` : '';
  const [commandCopied, copyCommand] = useCopy();
  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-hairline px-4">
      {/* Spike mark + wordmark, per the system's brand lockup. The lockup never
          wraps or compresses: opening the Inspector narrows this header, and the
          run command below gives up its width instead. */}
      <div className="flex shrink-0 items-center gap-2 text-ink">
        <SpikeMark size={15} />
        <span className="display text-[20px] tracking-[-0.3px] whitespace-nowrap">
          Agent DevTools
        </span>
      </div>

      {/* A status region: losing the change feed means the page has quietly
          stopped updating, which is exactly the kind of thing a screen reader
          user must not have to notice by re-reading the page. */}
      <span
        role="status"
        className={cx(
          'flex shrink-0 items-center gap-1.5 text-[13px]',
          connected ? 'text-success-fg' : 'text-muted-soft',
        )}
      >
        <span
          className={cx('h-1.5 w-1.5 rounded-full', connected ? 'bg-success' : 'bg-hairline')}
          aria-hidden
        />
        {connected ? 'live' : 'offline'}
      </span>

      {/*
        The run command is the one thing a first-time user needs, so it gets the
        dark code-window treatment rather than being another line of cream text.
      */}
      {config && (
        <div className="ml-2 flex min-w-0 items-center gap-2.5 rounded-lg border border-code-border bg-code py-1.5 pr-1.5 pl-3.5">
          {/* The command truncates from ~1024px down, and Copy still takes the
              whole string — so the title is the only way to read what you are
              about to copy. */}
          <code title={command} className="truncate font-mono text-[12.5px] text-code-fg">
            {command}
          </code>
          <button
            type="button"
            onClick={() => copyCommand(command)}
            className="shrink-0 rounded-md bg-code-elevated px-2.5 py-1 text-[12px] font-medium text-code-fg hover:bg-primary hover:text-primary-foreground"
          >
            {commandCopied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-3">
        {config && (
          <span
            title={config.upstream}
            className="max-w-[220px] truncate font-mono text-[12.5px] text-muted-soft"
          >
            → {config.upstream}
          </span>
        )}
        <ClearButton onClear={onClear} />
        <Button onClick={onOpenDiff}>Diff</Button>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
    </header>
  );
}
