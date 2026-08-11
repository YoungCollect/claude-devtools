import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Conversation } from '../../core/types.js';
import { formatClock } from '../format.js';
import { cx, Empty, TagLabel } from './ui.js';

/** Matches the server's cap, so the input cannot compose a rejected rename. */
const MAX_TITLE_LENGTH = 200;

export interface ConversationListProps {
  conversations: Conversation[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onDelete,
  onRename,
}: ConversationListProps) {
  if (conversations.length === 0) {
    return <Empty>No conversations yet.</Empty>;
  }

  // Subagent traces are rendered under the conversation that spawned them.
  // A conversation whose parent is gone — evicted by retention, or deleted —
  // is shown at the top level rather than disappearing with it.
  const byId = new Set(conversations.map((c) => c.id));
  const tops = conversations.filter(
    (c) => !c.parentConversationId || !byId.has(c.parentConversationId),
  );
  const childrenOf = (id: string) => conversations.filter((c) => c.parentConversationId === id);

  return (
    <div className="flex flex-col divide-y divide-hairline-soft">
      {tops.map((conversation) => (
        <Branch
          key={conversation.id}
          conversation={conversation}
          childrenOf={childrenOf}
          depth={0}
          selectedId={selectedId}
          onSelect={onSelect}
          onDelete={onDelete}
          onRename={onRename}
        />
      ))}
    </div>
  );
}

/**
 * One conversation and everything spawned beneath it, to any depth.
 *
 * Rendering only direct children lost a subagent's own subagent entirely: its
 * parent was present, so it was not an orphan, but nothing ever asked the
 * parent for its children once the parent was itself a child.
 */
function Branch({
  conversation,
  childrenOf,
  depth,
  selectedId,
  onSelect,
  onDelete,
  onRename,
}: {
  conversation: Conversation;
  childrenOf: (id: string) => Conversation[];
  depth: number;
  selectedId?: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
}) {
  return (
    <div>
      <Row
        conversation={conversation}
        selected={conversation.id === selectedId}
        onSelect={onSelect}
        onDelete={onDelete}
        onRename={onRename}
        nested={depth > 0}
      />
      {childrenOf(conversation.id).map((child) => (
        <Branch
          key={child.id}
          conversation={child}
          childrenOf={childrenOf}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
          onDelete={onDelete}
          onRename={onRename}
        />
      ))}
    </div>
  );
}

function Row({
  conversation,
  selected,
  onSelect,
  onDelete,
  onRename,
  nested = false,
}: {
  conversation: Conversation;
  selected: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  nested?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const [saving, setSaving] = useState(false);
  const [renameFailed, setRenameFailed] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        // A `menu` popup returns focus to its trigger on close — otherwise
        // Escape drops a keyboard user's focus back to the top of the page.
        menuTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  // Opening a `menu` moves focus onto it — a menuitem, not the trigger that
  // opened it — so arrow keys and typeahead work immediately.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [menuOpen]);

  const moveMenuFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    const current = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = items[(current + step + items.length) % items.length];
    next?.focus();
  };

  /**
   * Saves the edited title, or leaves edit mode when there is nothing to save.
   *
   * A blank draft is a cancel, not a rename to nothing: the server rejects an
   * empty title, and a conversation with no label is unusable in this list.
   */
  const commitRename = () => {
    const title = draft.trim();
    if (!title || title === conversation.title) {
      setRenaming(false);
      setRenameFailed(false);
      return;
    }
    setSaving(true);
    void onRename(conversation.id, title)
      .then(() => {
        setRenaming(false);
        setRenameFailed(false);
      })
      .catch(() => {
        // Stay in edit mode with the typing intact — a failed rename that
        // silently closed would look like it had been applied.
        setRenameFailed(true);
        inputRef.current?.focus();
      })
      .finally(() => setSaving(false));
  };

  if (renaming) {
    return (
      <div
        className={cx(
          'border-l-2 py-3 pr-3 pl-4',
          nested && 'pl-7',
          selected ? 'border-primary bg-surface-card' : 'border-transparent',
        )}
      >
        {nested && (
          <div className="mb-1.5">
            <TagLabel tone="tool">subagent</TagLabel>
          </div>
        )}
        <input
          ref={inputRef}
          autoFocus
          value={draft}
          maxLength={MAX_TITLE_LENGTH}
          disabled={saving}
          aria-label={`Rename ${conversation.title}`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitRename();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setRenaming(false);
              setRenameFailed(false);
            }
          }}
          onBlur={() => {
            if (!saving) commitRename();
          }}
          className="display w-full rounded-md border border-primary bg-canvas px-2 py-1 text-[15px] leading-[1.35] text-ink outline-none disabled:opacity-60"
        />
        <div className="mt-1.5 font-mono text-[12px] text-muted-soft">
          {saving
            ? 'Saving…'
            : renameFailed
              ? 'Rename failed — press Enter to retry'
              : 'Enter to save · Esc to cancel'}
        </div>
      </div>
    );
  }

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setMenuOpen(false);
          onSelect(conversation.id);
        }}
        className={cx(
          'w-full border-l-2 py-3 pr-11 pl-4 text-left transition-colors',
          nested && 'pl-7',
          selected ? 'border-primary bg-surface-card' : 'border-transparent hover:bg-surface-soft',
        )}
      >
        {nested && (
          <div className="mb-1.5">
            <TagLabel tone="tool">subagent</TagLabel>
          </div>
        )}
        {/* Conversation titles are the human's own words — serif, like the trace. */}
        <div className="display line-clamp-2 text-[15px] leading-[1.35] text-ink">
          {conversation.title}
        </div>
        {/* Time, then the two counts that name the tabs this row opens. */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[12px] text-muted-soft">
          <span>{formatClock(conversation.startedAt)}</span>
          {/* <span>· {conversation.nodeCount} trace</span> */}
          {/* <span>· {conversation.requestCount} network</span> */}
        </div>
      </button>

      <button
        ref={menuTriggerRef}
        type="button"
        aria-label={`Conversation actions for ${conversation.title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => {
          event.stopPropagation();
          setDeleteFailed(false);
          setMenuOpen((open) => !open);
        }}
        className="absolute top-2.5 right-2 flex h-7 w-7 items-center justify-center rounded-md text-muted-soft transition-colors hover:bg-canvas hover:text-ink"
      >
        <EllipsisIcon />
      </button>

      {menuOpen && (
        <div
          role="menu"
          aria-label={`Conversation actions for ${conversation.title}`}
          onKeyDown={moveMenuFocus}
          className="absolute top-9 right-2 z-20 min-w-32 rounded-lg border border-hairline bg-canvas p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              setDraft(conversation.title);
              setRenameFailed(false);
              setMenuOpen(false);
              setRenaming(true);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] font-medium text-ink hover:bg-surface-soft"
          >
            <PencilIcon />
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={deleting}
            onClick={(event) => {
              event.stopPropagation();
              setDeleting(true);
              void onDelete(conversation.id)
                .then(() => setMenuOpen(false))
                .catch(() => {
                  setDeleting(false);
                  setDeleteFailed(true);
                });
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] font-medium text-error-fg hover:bg-error-bg disabled:cursor-wait disabled:opacity-60"
          >
            <TrashIcon />
            {deleting ? 'Deleting…' : deleteFailed ? 'Retry delete' : 'Delete'}
          </button>
        </div>
      )}
    </div>
  );
}

function EllipsisIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="3" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="13" cy="8" r="1.2" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11.2 2.8a1.7 1.7 0 0 1 2.4 2.4L5.6 13.2 2.5 14l.8-3.1z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M3.5 5h9M6 5V3.5h4V5M5 7v5M8 7v5M11 7v5M4.25 5l.5 8h6.5l.5-8" />
    </svg>
  );
}
