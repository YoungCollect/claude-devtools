import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeToRevisions, type ServerConfig } from './api.js';
import type { StateSnapshot, TraceNode } from '../core/types.js';
import { ConversationList } from './components/ConversationList.js';
import { GitDiffDialog } from './components/GitDiffDialog.js';
import { Inspector } from './components/Inspector.js';
import { NetworkView } from './components/NetworkView.js';
import { TraceView } from './components/TraceView.js';
import { Badge, Button, cx, Empty, SpikeMark, Tabs, ThemeToggle } from './components/ui.js';
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

  return (
    <div className="flex h-full flex-col bg-canvas">
      <Header
        config={config}
        connected={connected}
        theme={theme}
        onToggleTheme={toggleTheme}
        onClear={() => {
          clearGitDiff();
          void api.clear().then(refresh);
        }}
        onOpenDiff={() => setGitDiffOpen(true)}
      />

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-hairline">
          <div className="border-b border-hairline px-4 py-3 text-[12px] font-medium tracking-[1.5px] text-muted-foreground uppercase">
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
          <div className="flex items-center border-b border-hairline py-2">
            <Tabs
              tabs={[
                { id: 'trace' as const, label: 'Chat Trace', count: nodes.length },
                { id: 'network' as const, label: 'Network', count: conversationTransport.length },
              ]}
              active={view}
              onChange={setView}
            />
            {view === 'trace' && conversation && (
              <div className="ml-auto flex items-center gap-2 px-4">
                <Badge tone="emph">{conversation.agent}</Badge>
                <span className="font-mono text-[12.5px] text-muted-foreground">{conversation.model}</span>
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
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
  onClear: () => void;
  onOpenDiff: () => void;
}) {
  const command = config ? `ANTHROPIC_BASE_URL=${config.proxyUrl} claude` : '';
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

      <span className={cx('flex shrink-0 items-center gap-1.5 text-[13px]', connected ? 'text-success-fg' : 'text-muted-soft')}>
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
        <div className="ml-2 flex min-w-0 items-center gap-2.5 rounded-lg bg-code py-1.5 pr-1.5 pl-3.5">
          <code className="truncate font-mono text-[12.5px] text-code-fg">{command}</code>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(command)}
            className="shrink-0 rounded-md bg-code-elevated px-2.5 py-1 text-[12px] font-medium text-code-fg hover:bg-primary hover:text-primary-foreground"
          >
            Copy
          </button>
        </div>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-3">
        {config && (
          <span className="max-w-[220px] truncate font-mono text-[12.5px] text-muted-soft">
            → {config.upstream}
          </span>
        )}
        <Button onClick={onClear} tone="danger">
          Clear
        </Button>
        <Button onClick={onOpenDiff}>Diff</Button>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
    </header>
  );
}
