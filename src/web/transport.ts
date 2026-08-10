/** Limits the Network view to transport records owned by the selected chat. */
export function transportForConversation<T extends { conversationId?: string }>(
  transport: readonly T[],
  conversationId: string | undefined,
): T[] {
  if (!conversationId) return [];
  return transport.filter((record) => record.conversationId === conversationId);
}
