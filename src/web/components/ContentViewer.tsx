import { memo, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  parseXmlOutline,
  xmlTextContent,
  type XmlElementNode,
  type XmlNode,
} from '../../core/xml-outline.js';
import type { GitDiffFormat, GitDiffSourceIdentity } from '../git-diff.js';
import { DiffSourceButtons } from './DiffSourceButtons.js';
import { Chevron, CopyIconButton, cx, Empty } from './ui.js';

export type ContentFormat = 'markdown' | 'xml';
type ViewMode = ContentFormat | 'raw';

export interface ContentViewerProps {
  text: string;
  /** Rendered views to offer, in order. `raw` is always appended. */
  formats: readonly ContentFormat[];
  /** Cap the rendered height; the panel scrolls past it. */
  maxHeightClass?: string;
  className?: string;
  diffSource?: GitDiffSourceIdentity;
  /**
   * `card` gives the viewer its own surface. `bare` inherits whatever it is
   * placed on — used by the chat bubbles, whose own fill is the thing that
   * marks a turn as the user's or the assistant's and so must survive the
   * viewer being dropped inside them.
   */
  variant?: 'card' | 'bare';
  /** Extra classes for the rendered prose, e.g. a bubble's own type scale. */
  proseClassName?: string;
}

/**
 * Both rendered views carry the same first word, so the toggle reads as one
 * control with a qualifier rather than two unrelated names you have to
 * remember. `Structure` said nothing that `Rendered · XML` does not, and it
 * only ever appeared next to `Rendered` on the blocks that have both.
 */
const LABELS: Record<ViewMode, string> = {
  markdown: 'Rendered · MD',
  xml: 'Rendered · XML',
  raw: 'Raw',
};

const STORAGE_KEY = 'agent-devtools:content-view';

/**
 * One preferred view, shared by every viewer on the page.
 *
 * Kept outside React and read through `useSyncExternalStore` so that switching
 * one block switches the others live — with several context blocks open at
 * once, having them disagree about whether you are reading source or prose is
 * the confusing state, not a feature.
 *
 * A viewer that cannot honour the preference (a tag block has no markdown view)
 * falls back to its own first format rather than showing nothing, so the choice
 * degrades per block instead of applying globally or not at all.
 */
let preferredMode: ViewMode | undefined = readStoredPreference();
const listeners = new Set<() => void>();

function isViewMode(value: unknown): value is ViewMode {
  return value === 'markdown' || value === 'xml' || value === 'raw';
}

function readStoredPreference(): ViewMode | undefined {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isViewMode(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

function subscribeToPreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getPreference(): ViewMode | undefined {
  return preferredMode;
}

function setPreference(mode: ViewMode): void {
  if (preferredMode === mode) return;
  preferredMode = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // A blocked storage quota must not break the viewer.
  }
  for (const listener of listeners) listener();
}

/**
 * Shows agent-authored text as markdown or as a tag outline, with the exact
 * source one click away.
 *
 * The raw toggle is not a nicety here. Rendering is interpretation, and this is
 * a tool for finding out what the model was actually sent — so every rendered
 * view has to be checkable against the bytes that went over the wire.
 */
export function ContentViewer({
  text,
  formats,
  maxHeightClass = 'max-h-[60vh]',
  className,
  diffSource,
  variant = 'card',
  proseClassName,
}: ContentViewerProps) {
  const modes = useMemo<ViewMode[]>(() => [...formats, 'raw'], [formats]);
  const preferred = useSyncExternalStore(subscribeToPreference, getPreference, getPreference);
  const active = preferred && modes.includes(preferred) ? preferred : (modes[0] ?? 'raw');

  // Only the source sits on the navy code card. Markdown and the tag outline are
  // both *rendered* views, so they share the canvas — flipping the whole panel
  // dark just because you switched between two renderings read as a mode change
  // that had not actually happened. Raw keeps the card: those are the literal
  // bytes off the wire, which is exactly what the dark surface is reserved for.
  //
  // A `bare` viewer never takes the card, in either mode: it has no surface of
  // its own to flip, and turning a user's turn navy on the way to Raw would
  // read as the turn changing rather than the view.
  const onCode = variant === 'card' && active === 'raw';
  const diffFormat: GitDiffFormat =
    active === 'markdown' || active === 'xml' ? active : (formats[0] ?? 'markdown');

  return (
    <div
      className={cx(
        variant === 'card'
          ? cx(
              'overflow-hidden rounded-lg border',
              onCode ? 'border-code-border bg-code' : 'border-hairline bg-canvas',
            )
          : 'flex flex-col',
        className,
      )}
    >
      {/*
        The controls sit in the card's own header rather than floating above it.
        Outside, they read as chrome belonging to the row; inside and right
        aligned they read as what they are — a control over this one panel — and
        the card keeps a single unbroken edge instead of two stacked blocks.

        The header does not scroll with the body, so the mode you are in stays
        visible however far down a 20 kB prompt you are.
      */}
      <div
        className={cx(
          'flex items-center justify-end gap-1.5',
          // Bare has no card edge for a rule to sit on, so the controls are
          // separated by space instead of a line they would otherwise draw
          // across the middle of a chat bubble.
          variant === 'card'
            ? cx('border-b px-2 py-1.5', onCode ? 'border-code-divider' : 'border-hairline')
            : 'pb-2',
        )}
      >
        {diffSource && (
          <DiffSourceButtons
            source={{ ...diffSource, text, format: diffFormat }}
            surface={onCode ? 'code' : 'canvas'}
          />
        )}
        {modes.map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => setPreference(candidate)}
            aria-pressed={candidate === active}
            className={cx(
              'h-[26px] rounded-md border px-2.5 text-[12px] font-medium transition-colors',
              candidate === active
                ? 'border-primary bg-primary text-primary-foreground'
                : onCode
                  ? 'border-code-elevated bg-code-elevated text-code-fg-soft hover:text-code-fg'
                  : 'border-hairline bg-canvas text-muted-foreground hover:border-muted-soft hover:text-ink',
            )}
          >
            {LABELS[candidate]}
          </button>
        ))}
        {/*
          Copy sits with the modes because what it copies is the source — the
          thing `Raw` shows — not the panel as a whole.
        */}
        <CopyIconButton text={text} surface={onCode ? 'code' : 'canvas'} />
      </div>

      <div className={cx('overflow-auto', maxHeightClass)}>
        {active === 'raw' ? (
          <RawPanel text={text} bare={variant === 'bare'} />
        ) : active === 'markdown' ? (
          <MarkdownPanel text={text} bare={variant === 'bare'} className={proseClassName} />
        ) : (
          <XmlPanel text={text} bare={variant === 'bare'} />
        )}
      </div>
    </div>
  );
}

/**
 * The source, unstyled and unwrapped. It shares `CodeBlock`'s type treatment but
 * not its card, because the card is now the shell around all three views.
 */
function RawPanel({ text, bare }: { text: string; bare: boolean }) {
  if (!text) return <Empty>No content</Empty>;
  return (
    <pre
      className={cx(
        'font-mono text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap',
        // Off the navy card, `code-fg` is light ink meant for a dark fill and
        // would be invisible, so a bare viewer takes the page's own ink and
        // keeps only the monospace treatment that marks this as source.
        bare ? 'text-body-strong' : 'p-3 text-code-fg',
      )}
    >
      {text}
    </pre>
  );
}

/**
 * Memoised on purpose. The trace refetches its nodes on every store revision,
 * which during a streaming response means a new nodes array roughly every 80ms.
 * Without this the panel re-parsed its whole source on each tick: measured at
 * +1.1s of script time across a single 3s turn for a 20 kB system prompt.
 *
 * Markdown sits on the canvas surface, not the dark code card: it is prose, and
 * the design system puts prose on cream and machine output on navy.
 *
 * `react-markdown` is used without `rehype-raw` on purpose. This text comes from
 * whatever the agent sent, so HTML in it must stay inert; the library's default
 * is to escape it, and its URL transform already drops `javascript:` links.
 */
const MarkdownPanel = memo(function MarkdownPanel({
  text,
  bare,
  className,
}: {
  text: string;
  bare: boolean;
  className?: string;
}) {
  return (
    <div className={cx('markdown-body', !bare && 'px-4 py-3', className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});

const XmlPanel = memo(function XmlPanel({ text, bare }: { text: string; bare: boolean }) {
  const nodes = useMemo(() => parseXmlOutline(text), [text]);
  return (
    <div
      className={cx(
        'font-mono text-[12.5px] leading-[1.6] text-markup-text',
        !bare && 'px-3 py-2.5',
      )}
    >
      <XmlNodes nodes={nodes} depth={0} />
    </div>
  );
});

function XmlNodes({ nodes, depth }: { nodes: readonly XmlNode[]; depth: number }) {
  return (
    <>
      {nodes.map((node, index) =>
        node.type === 'text' ? (
          <span key={index} className="whitespace-pre-wrap text-markup-text">
            {node.text}
          </span>
        ) : (
          <XmlElement key={index} node={node} depth={depth} />
        ),
      )}
    </>
  );
}

function XmlElement({ node, depth }: { node: XmlElementNode; depth: number }) {
  // Deep trees start folded so a long reminder does not bury the rest.
  const [open, setOpen] = useState(depth < 1);
  const preview = useMemo(() => xmlTextContent(node.children).replace(/\s+/g, ' ').trim(), [node]);

  if (node.selfClosing) {
    return (
      <div>
        <TagSyntax tag={node.tag} attributes={node.attributes} selfClosing />
      </div>
    );
  }

  return (
    <div className={depth > 0 ? 'border-l border-markup-divider pl-3' : undefined}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-baseline gap-1.5 text-left"
      >
        <span className="text-markup-tag">
          <Chevron open={open} />
        </span>
        <TagSyntax tag={node.tag} attributes={node.attributes} />
        {!open && preview && (
          <span className="min-w-0 flex-1 truncate text-muted-soft">{preview}</span>
        )}
      </button>
      {open && (
        <div className="pl-3">
          <XmlNodes nodes={node.children} depth={depth + 1} />
        </div>
      )}
      {open && <ClosingTag tag={node.tag} />}
    </div>
  );
}

function TagSyntax({
  tag,
  attributes,
  selfClosing = false,
}: {
  tag: string;
  attributes: string;
  selfClosing?: boolean;
}): ReactNode {
  return (
    <span className="shrink-0">
      <span className="text-markup-punct">&lt;</span>
      <span className="text-markup-tag">{tag}</span>
      {attributes && <span className="text-markup-attr"> {attributes}</span>}
      <span className="text-markup-punct">{selfClosing ? ' />' : '>'}</span>
    </span>
  );
}

function ClosingTag({ tag }: { tag: string }) {
  return (
    <span className="text-markup-punct">
      &lt;/<span className="text-markup-tag">{tag}</span>&gt;
    </span>
  );
}
