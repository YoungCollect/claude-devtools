/**
 * A deliberately lenient parser for the pseudo-XML agents actually emit.
 *
 * Claude Code wraps prose in tags like `<system-reminder>…</system-reminder>`,
 * but the *inside* is free text: markdown, code, generics, comparisons. It is
 * not XML and will not survive an XML parser. `react-xml-viewer`, the popular
 * choice here, silently reinterprets `if (a < b && c > d)` as a tag with
 * attributes `b="true" &&="true" c="true"` — for a debugging tool, quietly
 * showing something the agent never sent is worse than showing nothing.
 *
 * So this parser recognises *structure* and treats everything else as text:
 *
 *   - a tag opens only if a matching close tag exists later at the same depth
 *   - `<` that never resolves into a balanced pair stays literal text
 *   - attributes are captured verbatim, never interpreted
 *
 * The invariant that makes it safe to look at: `serialize(parse(input)) === input`
 * for every input. Structure may go unrecognised; content is never altered.
 */

export interface XmlTextNode {
  type: 'text';
  text: string;
}

export interface XmlElementNode {
  type: 'element';
  tag: string;
  /** Raw attribute text exactly as written, e.g. `type="note" open`. */
  attributes: string;
  /** True for `<br/>`-style tags, which have no children and no close tag. */
  selfClosing: boolean;
  children: XmlNode[];
  /** Exact source of the open tag, so serialization is lossless. */
  openRaw: string;
  /** Exact source of the close tag; empty when self-closing. */
  closeRaw: string;
}

export type XmlNode = XmlTextNode | XmlElementNode;

const TAG_NAME = '[A-Za-z_][\\w:.-]*';

export function parseXmlOutline(input: string): XmlNode[] {
  return parseNodes(input, 0, input.length);
}

function parseNodes(source: string, from: number, to: number): XmlNode[] {
  const nodes: XmlNode[] = [];
  let cursor = from;
  let textStart = from;

  const flushText = (end: number) => {
    if (end > textStart) nodes.push({ type: 'text', text: source.slice(textStart, end) });
  };

  while (cursor < to) {
    const lt = source.indexOf('<', cursor);
    if (lt === -1 || lt >= to) break;

    const open = matchOpenTag(source, lt, to);
    if (!open) {
      // Not a tag we recognise — a stray `<`, a comparison, an unclosed tag.
      // Leave it as text and keep scanning after it.
      cursor = lt + 1;
      continue;
    }

    if (open.selfClosing) {
      flushText(lt);
      nodes.push({
        type: 'element',
        tag: open.tag,
        attributes: open.attributes,
        selfClosing: true,
        children: [],
        openRaw: source.slice(lt, open.end),
        closeRaw: '',
      });
      cursor = textStart = open.end;
      continue;
    }

    const close = findMatchingClose(source, open.tag, open.end, to);
    if (!close) {
      // An open tag with no partner is prose, not structure.
      cursor = lt + 1;
      continue;
    }

    flushText(lt);
    nodes.push({
      type: 'element',
      tag: open.tag,
      attributes: open.attributes,
      selfClosing: false,
      children: parseNodes(source, open.end, close.start),
      openRaw: source.slice(lt, open.end),
      closeRaw: source.slice(close.start, close.end),
    });
    cursor = textStart = close.end;
  }

  flushText(to);
  return nodes;
}

interface OpenTag {
  tag: string;
  attributes: string;
  selfClosing: boolean;
  /** Index just past `>`. */
  end: number;
}

function matchOpenTag(source: string, at: number, limit: number): OpenTag | undefined {
  const pattern = new RegExp(`^<(${TAG_NAME})((?:"[^"]*"|'[^']*'|[^>"'])*)>`);
  const slice = source.slice(at, limit);
  const match = pattern.exec(slice);
  if (!match) return undefined;

  const tag = match[1] ?? '';
  let attributes = (match[2] ?? '').trim();
  const selfClosing = attributes.endsWith('/');
  if (selfClosing) attributes = attributes.slice(0, -1).trim();

  return { tag, attributes, selfClosing, end: at + match[0].length };
}

/**
 * Finds the close tag that belongs to this open tag, honouring nesting of the
 * same name so `<a><a>x</a></a>` pairs up correctly.
 */
function findMatchingClose(
  source: string,
  tag: string,
  from: number,
  to: number,
): { start: number; end: number } | undefined {
  const scanner = new RegExp(`<(/?)(${escapeRegExp(tag)})((?:"[^"]*"|'[^']*'|[^>"'])*)>`, 'g');
  scanner.lastIndex = from;

  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(source)) !== null) {
    if (match.index >= to) break;
    const isClose = match[1] === '/';
    const attributes = match[3] ?? '';
    if (!isClose) {
      if (!attributes.trimEnd().endsWith('/')) depth += 1;
      continue;
    }
    if (depth === 0) return { start: match.index, end: match.index + match[0].length };
    depth -= 1;
  }
  return undefined;
}

/** Inverse of {@link parseXmlOutline}. Must reproduce the input byte for byte. */
export function serializeXmlOutline(nodes: readonly XmlNode[]): string {
  return nodes
    .map((node) =>
      node.type === 'text'
        ? node.text
        : node.openRaw + serializeXmlOutline(node.children) + node.closeRaw,
    )
    .join('');
}

/** Concatenated text of a subtree, used for collapsed previews. */
export function xmlTextContent(nodes: readonly XmlNode[]): string {
  return nodes
    .map((node) => (node.type === 'text' ? node.text : xmlTextContent(node.children)))
    .join('');
}

/** True when the text has at least one balanced tag worth outlining. */
export function hasXmlStructure(text: string): boolean {
  return parseXmlOutline(text).some((node) => node.type === 'element');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
