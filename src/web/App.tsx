import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeToRevisions, type ServerConfig } from './api.js';
import type { StateSnapshot, TraceNode } from '../core/types.js';
import { ConversationList } from './components/ConversationList.js';
import { Inspector } from './components/Inspector.js';
import { NetworkView } from './components/NetworkView.js';
import { TraceView } from './components/TraceView.js';
import { Badge, CopyButton, cx, Empty, Tabs } from './components/ui.js';

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

  const inspectNode = useCallback((node: TraceNode) => {
    const transportId = node.producedByRequestId ?? node.revealedByRequestId;
    if (!transportId) return;
    setSelection({ transportId, node });
  }, []);

  const conversation = snapshot.conversations.find((c) => c.id === conversationId);

  return (
    <div className="flex h-full flex-col bg-ink-950">
      <Header config={config} connected={connected} onClear={() => void api.clear().then(refresh)} />

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-ink-800">
          <div className="border-b border-ink-800 px-3 py-2 text-[10px] font-medium tracking-wider text-ink-400 uppercase">
            Conversations
          </div>
          <ConversationList
            conversations={snapshot.conversations}
            selectedId={conversationId}
            onSelect={(id) => {
              pinned.current = true;
              setConversationId(id);
            }}
          />
        </nav>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center border-b border-ink-800">
            <Tabs
              tabs={[
                { id: 'trace' as const, label: 'Chat Trace', count: nodes.length },
                { id: 'network' as const, label: 'Network', count: snapshot.transport.length },
              ]}
              active={view}
              onChange={setView}
            />
            {view === 'trace' && conversation && (
              <div className="ml-auto flex items-center gap-1.5 px-3 font-mono text-[10px] text-ink-400">
                <Badge tone="accent">{conversation.agent}</Badge>
                <span>{conversation.model}</span>
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
                transport={snapshot.transport}
                selectedId={selection?.transportId}
                onSelect={(id) => setSelection({ transportId: id })}
              />
            )}
          </div>
        </main>

        {selection && (
          <Inspector
            transportId={selection.transportId}
            focusNode={selection.node}
            rev={snapshot.rev}
            onClose={() => setSelection(undefined)}
          />
        )}
      </div>
    </div>
  );
}

function Header({
  config,
  connected,
  onClear,
}: {
  config: ServerConfig | undefined;
  connected: boolean;
  onClear: () => void;
}) {
  const command = config ? `ANTHROPIC_BASE_URL=${config.proxyUrl} claude` : '';
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-ink-800 px-3 py-2">
      <span className="text-[13px] font-semibold tracking-tight text-ink-100">Agent DevTools</span>
      <span
        className={cx(
          'flex items-center gap-1.5 font-mono text-[10px]',
          connected ? 'text-ok' : 'text-ink-400',
        )}
      >
        <span
          className={cx('h-1.5 w-1.5 rounded-full', connected ? 'bg-ok' : 'bg-ink-600')}
          aria-hidden
        />
        {connected ? 'live' : 'offline'}
      </span>

      {config && (
        <div className="ml-2 flex items-center gap-2 rounded border border-ink-800 bg-ink-900 px-2 py-1">
          <code className="font-mono text-[10.5px] text-ink-300">{command}</code>
          <CopyButton text={command} />
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        {config && (
          <span className="font-mono text-[10px] text-ink-400">→ {config.upstream}</span>
        )}
        <button
          type="button"
          onClick={onClear}
          className="rounded border border-ink-700 px-2 py-0.5 font-mono text-[10px] text-ink-400 hover:border-danger/40 hover:text-danger"
        >
          Clear
        </button>
      </div>
    </header>
  );
}
