import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '../../core/types.js';
import { formatClock, formatTokens } from '../format.js';
import { cx, Empty, TagLabel } from './ui.js';

export interface ConversationListProps {
  conversations: Conversation[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onDelete,
}: ConversationListProps) {
  if (conversations.length === 0) {
    return <Empty>No conversations yet.</Empty>;
  }

  // Subagent traces are rendered under the conversation that spawned them.
  const roots = conversations.filter((c) => !c.parentConversationId);
  const childrenOf = (id: string) => conversations.filter((c) => c.parentConversationId === id);
  const orphans = conversations.filter(
    (c) => c.parentConversationId && !conversations.some((p) => p.id === c.parentConversationId),
  );

  return (
    <div className="flex flex-col divide-y divide-hairline-soft">
      {[...roots, ...orphans].map((conversation) => (
        <div key={conversation.id}>
          <Row
            conversation={conversation}
            selected={conversation.id === selectedId}
            onSelect={onSelect}
            onDelete={onDelete}
          />
          {childrenOf(conversation.id).map((child) => (
            <Row
              key={child.id}
              conversation={child}
              selected={child.id === selectedId}
              onSelect={onSelect}
              onDelete={onDelete}
              nested
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function Row({
  conversation,
  selected,
  onSelect,
  onDelete,
  nested = false,
}: {
  conversation: Conversation;
  selected: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  nested?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

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
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[12px] text-muted-soft">
          <span>{formatClock(conversation.startedAt)}</span>
          <span>· {conversation.requestCount} req</span>
          <span>· {conversation.nodeCount} nodes</span>
          {conversation.usage.outputTokens !== undefined && (
            <span>· ↓{formatTokens(conversation.usage.outputTokens)}</span>
          )}
        </div>
        {conversation.model && (
          <div className="mt-1 truncate font-mono text-[12px] text-muted-soft">
            {conversation.model}
          </div>
        )}
      </button>

      <button
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
          className="absolute top-9 right-2 z-20 min-w-32 rounded-lg border border-hairline bg-canvas p-1 shadow-lg"
        >
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
