import type { Conversation } from '../../core/types.js';
import { formatClock, formatTokens } from '../format.js';
import { cx, Empty, TagLabel } from './ui.js';

export interface ConversationListProps {
  conversations: Conversation[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

export function ConversationList({ conversations, selectedId, onSelect }: ConversationListProps) {
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
          />
          {childrenOf(conversation.id).map((child) => (
            <Row
              key={child.id}
              conversation={child}
              selected={child.id === selectedId}
              onSelect={onSelect}
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
  nested = false,
}: {
  conversation: Conversation;
  selected: boolean;
  onSelect: (id: string) => void;
  nested?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(conversation.id)}
      className={cx(
        'w-full border-l-2 px-4 py-3 text-left transition-colors',
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
  );
}
