import { parseXmlOutline } from './xml-outline.js';

export interface TaggedTextSegment {
  kind: 'context' | 'user';
  text: string;
  contextTag?: string;
}

/** Classifies a whole provider text block as wrapped context or ordinary user text. */
export function splitTaggedUserContent(text: string): TaggedTextSegment[] {
  const content = text.trim();
  if (!content) return [];

  const nodes = parseXmlOutline(content);
  const [root] = nodes;
  if (nodes.length === 1 && root?.type === 'element' && !root.selfClosing) {
    return [{ kind: 'context', contextTag: root.tag, text: content }];
  }

  return [{ kind: 'user', text: content }];
}
