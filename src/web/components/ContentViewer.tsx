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
import { ContentToolbar, type ContentFormat, type ViewMode } from './ContentToolbar.js';
import { DataSurface, DataSurfaceBody } from './DataSurface.js';
import { Chevron, cx, Empty } from './ui.js';

export type { ContentFormat };

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
  /**
   * Which edge the control row hangs off.
   *
   * `end` is the default and suits anything right-aligned or full-width. `start`
   * mirrors the row for a left-hand bubble: the controls move to the left edge
   * *and* reverse, so Copy — the outermost control on the right-hand side —
   * stays outermost on the left. A row that only moved would put Copy in the
   * middle of the bubble and break the symmetry between the two speakers.
   */
  controlsAlign?: 'start' | 'end';
  /**
   * Which end of the panel the control row sits on.
   *
   * `top` keeps it in view while you scroll a 20 kB prompt, which is what the
   * Inspector wants. `bottom` suits a block that is read from its first line,
   * where a row of controls above that line is the first thing the eye lands
   * on.
   *
   * `external` draws no row at all: the caller renders `ContentToolbar` itself,
   * outside this panel. The chat bubbles do that — their controls belong under
   * the bubble, on the page, and a child cannot escape its parent's fill.
   */
  controlsPlacement?: 'top' | 'bottom' | 'external';
  /**
   * Whether the Rendered/Raw toggle is offered.
   *
   * The Chat Trace passes `false`: Copy already hands you the exact source, so
   * the toggle was buying a view of the bytes that was one click away anyway,
   * at the cost of two more controls on every single turn. Where the source is
   * the point — the transport Inspector — the toggle stays.
   *
   * With the toggle hidden the panel also ignores the shared preference and
   * pins itself to its first rendered format. Inheriting a `raw` preference set
   * elsewhere would strand the reader in source with no control to leave it.
   */
  showViewModes?: boolean;
}

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
 * The view a panel is showing, and the control to change it.
 *
 * Exported because a caller can host the control row outside the panel — the
 * chat trace does, so the row sits on the page under the block rather than
 * inside its card. Both sides read the same shared preference, so a row and the
 * panel it belongs to derive the same `active` from the same source; there is
 * no second copy of the state to fall out of step.
 */
export function useContentViewMode(
  formats: readonly ContentFormat[],
  showViewModes: boolean,
): { modes: ViewMode[]; active: ViewMode; setMode: (mode: ViewMode) => void } {
  const modes = useMemo<ViewMode[]>(() => [...formats, 'raw'], [formats]);
  const preferred = useSyncExternalStore(subscribeToPreference, getPreference, getPreference);
  const fallback = modes[0] ?? 'raw';
  const active = !showViewModes
    ? fallback
    : preferred && modes.includes(preferred)
      ? preferred
      : fallback;
  return { modes, active, setMode: setPreference };
}

/**
 * The format a diff should take this text as: whichever rendered view is on
 * screen, or the panel's first rendered format when the reader is in `raw` —
 * raw is not something a diff can be rendered as.
 */
export function diffFormatFor(
  active: ViewMode,
  formats: readonly ContentFormat[],
): GitDiffFormat {
  return active === 'markdown' || active === 'xml' ? active : (formats[0] ?? 'markdown');
}

/**
 * Shows agent-authored text as markdown or as a tag outline, with the exact
 * source one click away.
 *
 * The raw toggle is not a nicety here. Rendering is interpretation, and this is
 * a tool for finding out what the model was actually sent — so every rendered
 * view has to be checkable against the bytes that went over the wire. Where the
 * panel is for reading rather than for auditing, `showViewModes` hides the
 * toggle and leaves that job to Copy, which always yields the source.
 */
export function ContentViewer({
  text,
  formats,
  maxHeightClass = 'max-h-[60vh]',
  className,
  diffSource,
  variant = 'card',
  proseClassName,
  controlsAlign = 'end',
  controlsPlacement = 'top',
  showViewModes = true,
}: ContentViewerProps) {
  const { modes, active, setMode } = useContentViewMode(formats, showViewModes);

  // Every standalone renderer uses the same theme-adaptive ground. Markdown,
  // XML and raw source communicate format through typography and syntax, not
  // through a different panel colour. A bare chat viewer still inherits the
  // message surface supplied by its caller.
  const usesDataSurface = variant === 'card';
  const diffFormat = diffFormatFor(active, formats);

  const toolbar = controlsPlacement === 'external' ? undefined : (
    <ContentToolbar
      text={text}
      diff={diffSource && { source: diffSource, format: diffFormat }}
      viewModes={showViewModes ? { options: modes, active, onSelect: setMode } : undefined}
      variant={variant}
      align={controlsAlign}
      edge={controlsPlacement}
    />
  );

  const body = (
    <div className={cx('scroll-surface overflow-auto', maxHeightClass)}>
      {active === 'raw' ? (
        <RawPanel text={text} bare={variant === 'bare'} />
      ) : active === 'markdown' ? (
        <MarkdownPanel text={text} bare={variant === 'bare'} className={proseClassName} />
      ) : (
        <XmlPanel text={text} bare={variant === 'bare'} />
      )}
    </div>
  );

  if (usesDataSurface) {
    return (
      <DataSurface variant="block" className={className}>
        {controlsPlacement === 'top' && toolbar}
        {body}
        {controlsPlacement === 'bottom' && toolbar}
      </DataSurface>
    );
  }

  return (
    <div className={cx('flex flex-col', className)}>
      {controlsPlacement === 'top' && toolbar}
      {body}
      {controlsPlacement === 'bottom' && toolbar}
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
        bare ? 'text-body-strong' : 'p-3 text-data-foreground',
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
 * Standalone Markdown sits on the same DataSurface as XML and JSON. In a chat
 * message the bare renderer inherits the message's canvas surface instead.
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
          pre: ({ children }) =>
            bare ? (
              // A chat message already owns its background, border, radius and
              // padding. Keeping another DataSurface here creates the exact
              // double-container hierarchy the message shell is meant to avoid.
              <pre className="markdown-code-block scroll-surface my-[0.8em] overflow-auto">
                {children}
              </pre>
            ) : (
              <DataSurface variant="block" className="markdown-code-block my-[0.8em]">
                <DataSurfaceBody className="px-4 py-3">{children}</DataSurfaceBody>
              </DataSurface>
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
        'font-mono text-[12.5px] leading-[1.6]',
        bare ? 'text-body-strong' : 'text-data-foreground',
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
          <span key={index} className="whitespace-pre-wrap">
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
    <div className={depth > 0 ? 'border-l border-data-divider pl-3' : undefined}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-baseline gap-1.5 text-left"
      >
        <span className="text-syntax-tag">
          <Chevron open={open} />
        </span>
        <TagSyntax tag={node.tag} attributes={node.attributes} />
        {!open && preview && (
          <span className="min-w-0 flex-1 truncate text-data-foreground-muted">{preview}</span>
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
      <span className="text-syntax-punctuation">&lt;</span>
      <span className="text-syntax-tag">{tag}</span>
      {attributes && <span className="text-syntax-attribute"> {attributes}</span>}
      <span className="text-syntax-punctuation">{selfClosing ? ' />' : '>'}</span>
    </span>
  );
}

function ClosingTag({ tag }: { tag: string }) {
  return (
    <span className="text-syntax-punctuation">
      &lt;/<span className="text-syntax-tag">{tag}</span>&gt;
    </span>
  );
}
