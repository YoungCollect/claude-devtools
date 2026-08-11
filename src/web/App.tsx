import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Columns2, Menu, Settings, Terminal, Trash2 } from 'lucide-react';
import { api, subscribeToRevisions, type ServerConfig } from './api.js';
import { DataSurface } from './components/DataSurface.js';
import type { StateSnapshot, TraceNode } from '../core/types.js';
import { AgentSelect } from './components/AgentSelect.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './components/ui/alert-dialog.js';
import { Button } from './components/ui/button.js';
import { ConversationList } from './components/ConversationList.js';
import { GitDiffDialog } from './components/GitDiffDialog.js';
import { Inspector } from './components/Inspector.js';
import { NetworkView } from './components/NetworkView.js';
import { TraceView } from './components/TraceView.js';
import {
  cx,
  HeaderIconButton,
  SpikeMark,
  tabPanelProps,
  Tabs,
  ThemeToggle,
  useCopy,
} from './components/ui.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './components/ui/tooltip.js';
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

/** The one line a user has to run to point an agent at this proxy. */
function runCommand(config: ServerConfig | undefined): string {
  return config ? `ANTHROPIC_BASE_URL=${config.proxyUrl} claude` : '';
}

/**
 * The empty trace pane, which doubles as the onboarding step.
 *
 * The header no longer prints the run command — it is a shell mark there — so
 * this is the one place the command is spelled out, and it is exactly where
 * someone who has captured nothing yet is already looking. The old copy sent
 * them to "the proxy base URL shown above", which is no longer shown at all.
 */
function WaitingForTraffic({ command }: { command: string }) {
  const [copied, copy] = useCopy();
  const label = copied ? 'Copied' : 'Copy run command';
  return (
    <div className="flex flex-col items-start gap-3 px-1 py-4">
      <p className="text-[14px] text-muted-soft italic">
        Waiting for traffic. Start an agent pointed at the capture proxy:
      </p>
      {command && (
        <DataSurface variant="inline" className="max-w-full">
          <code className="truncate font-mono text-[12.5px] text-data-foreground">{command}</code>
          {/* A code-surface control, not a header one: it sits on the dark
              surface and takes its fill from the `data-*` tokens. */}
          <Tooltip>
            <TooltipTrigger
              type="button"
              onClick={() => copy(command)}
              aria-label={label}
              closeOnClick={false}
              className={cx(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-data-surface-control transition-colors',
                copied
                  ? 'text-success-fg'
                  : 'text-data-foreground-muted hover:bg-primary hover:text-primary-foreground',
              )}
            >
              {copied ? <Check size={14} aria-hidden /> : <Terminal size={14} aria-hidden />}
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        </DataSurface>
      )}
    </div>
  );
}

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
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
    return next;
  }, []);

  // `connected` is the change feed's own state, reported by the subscription
  // (see `subscribeToRevisions`) — not something inferred from the refetches it
  // triggers. A failed refetch can still pull it down: the feed being open does
  // not help if the reads behind it are failing. Only the feed can raise it.
  useEffect(() => {
    void refresh().catch(() => setConnected(false));
    return subscribeToRevisions({
      onStatus: setConnected,
      onRevision: () => {
        void refresh().catch(() => setConnected(false));
      },
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

  // Escape closes the narrow-viewport conversation panel, the same way it
  // closes the Inspector drawer and the conversation actions menu.
  useEffect(() => {
    if (!sidebarOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [sidebarOpen]);

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
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onClear={async () => {
            clearGitDiff();
            // Rejects on failure so the button can show it; refreshing on a failed
            // clear would present unchanged data as if the wipe had worked.
            await api.clear();
            await refresh();
          }}
          onOpenDiff={() => setGitDiffOpen(true)}
        />

        <div className="relative flex min-h-0 flex-1">
          {/* Below 768px the sidebar is 288px fixed-width against a viewport
              that can be as narrow as 320px — on its own, wider than the
              screen (P1-03's follow-on in the product design audit). It
              becomes an off-canvas panel there, toggled by the header's menu
              button; at `md` and up it is always visible, exactly as before.

              Both the scrim and the panel are `absolute` inside this row
              rather than `fixed` to the viewport, so neither covers the
              header: the menu toggle that opened the panel, and Clear / Diff /
              the theme switch beside it, all stay reachable while it is open. */}
          {sidebarOpen && (
            <button
              type="button"
              aria-label="Close conversation list"
              onClick={() => setSidebarOpen(false)}
              className="absolute inset-0 z-30 bg-overlay md:hidden"
            />
          )}
          <nav
            id="conversation-sidebar"
            className={cx(
              'scroll-surface flex w-72 shrink-0 flex-col overflow-y-auto border-r border-hairline bg-canvas',
              'max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40',
              // `visibility` alongside the slide, because a panel parked
              // off-screen with `-translate-x-full` is still focusable and
              // still in the accessibility tree — a keyboard user at a narrow
              // width would tab into an invisible conversation list.
              // Transitioning it means `hidden` only lands once the panel has
              // finished sliding out, so the animation survives.
              'transition-[transform,visibility] duration-200',
              sidebarOpen
                ? 'max-md:visible max-md:translate-x-0'
                : 'max-md:invisible max-md:-translate-x-full md:visible',
            )}
          >
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
                // A touch user is done with the panel once they've picked a
                // conversation — leaving it open would cover the trace they
                // just opened it to reach.
                setSidebarOpen(false);
              }}
              onDelete={async (id) => {
                await api.deleteConversation(id);
                await refresh();
              }}
              // Rejects on failure so the row can stay in edit mode; refreshing
              // regardless would redraw the old title as if nothing was wrong.
              onRename={async (id, title) => {
                await api.renameConversation(id, title);
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
              {/* Nothing sits opposite the tabs. The agent name became the
                  header's logo, and the model now rides on each assistant turn
                  — where it belongs, since a conversation-level model is only
                  ever the newest turn's and says nothing about the ones above
                  it. */}
            </div>

            <div
              className="scroll-surface min-h-0 flex-1 overflow-y-auto"
              ref={trace.ref}
              onScroll={trace.onScroll}
              {...tabPanelProps('view', view)}
            >
              {view === 'trace' ? (
                conversation ? (
                  <TraceView nodes={nodes} selectedNodeId={selection?.node?.id} onInspect={inspectNode} />
                ) : (
                  <WaitingForTraffic command={runCommand(config)} />
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
 * Clear, behind a confirm.
 *
 * Deleting one conversation takes two deliberate acts and reports progress and
 * failure. Clear wipes every conversation, every trace and the database, cannot
 * be undone, and sits one stray click from the theme toggle — the protection
 * was inverted relative to the damage.
 *
 * A modal rather than the in-place arm it replaces. The arm asked for a second
 * click on the same 32px target the first one landed on, which is the click a
 * slip repeats; an alert dialog moves the confirm somewhere the pointer has to
 * travel, states what is about to be destroyed, and cannot be dismissed by an
 * outside click or a stray Escape. Cancel holds the initial focus, so a Return
 * pressed out of habit closes the dialog rather than wiping the capture.
 */
function ClearButton({ onClear }: { onClear: () => Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'idle' | 'clearing' | 'failed'>('idle');

  // Icon-only, so the label carries the whole warning.
  const label =
    state === 'clearing'
      ? 'Clearing…'
      : state === 'failed'
        ? 'Clear failed — try again'
        : 'Clear all captured traces';

  return (
    <>
      <HeaderIconButton
        label={label}
        tone={state === 'failed' ? 'danger' : 'neutral'}
        onClick={() => {
          if (state === 'clearing') return;
          setOpen(true);
        }}
      >
        <Trash2 size={15} aria-hidden />
      </HeaderIconButton>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all captured traces?</AlertDialogTitle>
            <AlertDialogDescription>
              Every conversation, trace and stored request body is removed from memory and
              deleted from disk. Requests still in flight are dropped. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* `autoFocus` on the safe exit: a dialog that opens with the
                destructive button focused is a dialog that a held Return key
                confirms for you. */}
            <AlertDialogCancel autoFocus render={<Button variant="outline" />}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              render={<Button variant="destructive" />}
              onClick={() => {
                setState('clearing');
                void Promise.resolve(onClear()).then(
                  () => setState('idle'),
                  () => setState('failed'),
                );
              }}
            >
              Clear everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * The header's settings disclosure: what this proxy is wired to, in one place.
 *
 * Everything in it is read-only local runtime config the server already reports
 * over `/api/config`. It earns its slot because the row itself cannot afford to
 * always show these: upstream drops off below `lg`, and the run command is a
 * shell mark now. This is the one place both are always spelled out in full.
 */
function SettingsPopover({ config }: { config: ServerConfig }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [copied, copy] = useCopy();
  const command = runCommand(config);
  const copyLabel = copied ? 'Copied' : 'Copy run command';

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      // Escape returns focus to the trigger — the same contract as the
      // conversation actions menu — rather than dropping a keyboard user back
      // at the top of the page.
      rootRef.current?.querySelector('button')?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <HeaderIconButton
        label="Connection settings"
        expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Settings size={15} aria-hidden />
      </HeaderIconButton>

      {open && (
        <div
          role="dialog"
          aria-label="Connection settings"
          className="absolute top-10 right-0 z-30 w-80 rounded-lg border border-hairline bg-canvas p-3 shadow-lg"
        >
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-[12.5px]">
            <SettingRow label="Proxy" value={config.proxyUrl} />
            <SettingRow label="Upstream" value={config.upstream} />
            <SettingRow label="UI port" value={String(config.uiPort)} />
          </dl>

          {/* The command gets the code-surface treatment here rather than being
              a fourth row of cream text: it is the one value you act on, not a
              value you read. */}
          {/* <DataSurface variant="inline" className="mt-3 w-full">
            <code className="truncate font-mono text-[12.5px] text-data-foreground">{command}</code>
            <Tooltip>
              <TooltipTrigger
                type="button"
                onClick={() => copy(command)}
                aria-label={copyLabel}
                closeOnClick={false}
                className={cx(
                  'ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-data-surface-control transition-colors',
                  copied
                    ? 'text-success-fg'
                    : 'text-data-foreground-muted hover:bg-primary hover:text-primary-foreground',
                )}
              >
                {copied ? <Check size={14} aria-hidden /> : <Terminal size={14} aria-hidden />}
              </TooltipTrigger>
              <TooltipContent>{copyLabel}</TooltipContent>
            </Tooltip>
          </DataSurface> */}
        </div>
      )}
    </div>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono break-all text-ink">{value}</dd>
    </>
  );
}

function Header({
  config,
  connected,
  theme,
  onToggleTheme,
  sidebarOpen,
  onToggleSidebar,
  onClear,
  onOpenDiff,
}: {
  config: ServerConfig | undefined;
  connected: boolean;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onClear: () => Promise<void> | void;
  onOpenDiff: () => void;
}) {
  const command = runCommand(config);
  const [commandCopied, copyCommand] = useCopy();
  const copyLabel = commandCopied ? 'Copied' : `Copy run command: ${command}`;
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-hairline px-3 sm:gap-4 sm:px-4">
      {/* The sidebar's own toggle — visible only below `md`, where the
          conversation list is an off-canvas panel rather than a permanent
          column. */}
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label="Toggle conversation list"
        aria-expanded={sidebarOpen}
        aria-controls="conversation-sidebar"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-soft hover:text-ink md:hidden"
      >
        <Menu size={17} aria-hidden />
      </button>

      {/* Spike mark + wordmark, per the system's brand lockup. The lockup never
          wraps or compresses: opening the Inspector narrows this header, and the
          run command below gives up its width instead. */}
      <div className="flex shrink-0 items-center gap-2 text-ink">
        <SpikeMark size={15} />
        <span className="display text-[20px] tracking-[-0.3px] whitespace-nowrap max-sm:hidden">
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
        The right-hand cluster, in one fixed order: where the traffic goes
        (upstream), how to point traffic here (the shell mark), then the tools
        that act on what was captured — diff, clear — then the controls that
        change nothing about the capture at all: theme, settings, and the agent
        the UI is pointed at. Destination first, then actions, then chrome.
      */}
      <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
        {/* {config && (
          <span
            title={config.upstream}
            // Hidden below `lg`: with four controls competing for the same
            // row, upstream is the one that can be recovered from the tooltip
            // instead of pushing on the buttons beside it.
            className="hidden max-w-[220px] truncate font-mono text-[12.5px] text-muted-soft lg:block"
          >
            → {config.upstream}
          </span>
        )} */}
        {/* The run command is no longer printed in the header, so the tooltip
            is the only place it can be read — it names the exact string the
            click puts on the clipboard rather than just promising "Copy". The
            tick swaps tooltip and `aria-label` together, so pointer and
            screen-reader users get the same confirmation. */}
        <AgentSelect />
        {config && (
          <HeaderIconButton label={copyLabel} onClick={() => copyCommand(command)}>
            {commandCopied ? (
              <Check size={15} className="text-success-fg" aria-hidden />
            ) : (
              <Terminal size={15} aria-hidden />
            )}
          </HeaderIconButton>
        )}
        <HeaderIconButton label="Open git diff" onClick={onOpenDiff}>
          <Columns2 size={15} aria-hidden />
        </HeaderIconButton>
        <ClearButton onClear={onClear} />
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        {config && <SettingsPopover config={config} />}
      </div>
    </header>
  );
}
