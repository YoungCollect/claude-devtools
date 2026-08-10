import type { Conversation } from '../../core/types.js';
import { formatClock, formatTokens } from '../format.js';
import { Badge, cx, Empty } from './ui.js';

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
    <div className="flex flex-col">
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
        'w-full border-l-2 px-3 py-2 text-left transition-colors',
        nested && 'pl-6',
        selected
          ? 'border-accent bg-accent/[0.08]'
          : 'border-transparent hover:border-ink-700 hover:bg-ink-900',
      )}
    >
      <div className="flex items-center gap-1.5">
        {nested && <Badge tone="tool">subagent</Badge>}
        <span className="truncate text-[12px] text-ink-100">{conversation.title}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-ink-400">
        <span>{formatClock(conversation.startedAt)}</span>
        <span>· {conversation.requestCount} req</span>
        <span>· {conversation.nodeCount} nodes</span>
        {conversation.usage.outputTokens !== undefined && (
          <span>· ↓{formatTokens(conversation.usage.outputTokens)}</span>
        )}
      </div>
      {conversation.model && (
        <div className="mt-1 truncate font-mono text-[10px] text-ink-400">{conversation.model}</div>
      )}
    </button>
  );
}
