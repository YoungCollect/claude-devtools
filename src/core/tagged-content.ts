export interface TaggedTextSegment {
  kind: 'context' | 'user';
  text: string;
  contextTag?: string;
}

/** Splits balanced `<tag>...</tag>` wrappers from ordinary user-authored text. */
export function splitTaggedUserContent(text: string): TaggedTextSegment[] {
  const taggedBlock = /<([A-Za-z][\w:.-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/g;
  const segments: TaggedTextSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(taggedBlock)) {
    const index = match.index ?? 0;
    pushPlainSegment(segments, text.slice(cursor, index));
    const wrapped = match[0].trim();
    const tag = match[1];
    if (wrapped && tag) segments.push({ kind: 'context', contextTag: tag, text: wrapped });
    cursor = index + match[0].length;
  }
  pushPlainSegment(segments, text.slice(cursor));
  return segments;
}

function pushPlainSegment(segments: TaggedTextSegment[], text: string): void {
  const plain = text.trim();
  if (plain) segments.push({ kind: 'user', text: plain });
}
