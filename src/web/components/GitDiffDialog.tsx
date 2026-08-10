import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Columns2, RotateCcw, X } from 'lucide-react';

import type { Theme } from '../theme.js';
import {
  clearGitDiff,
  clearGitDiffSide,
  setGitDiffOpen,
  useGitDiff,
  type GitDiffSource,
  type GitDiffSide,
} from '../git-diff.js';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

const LazyMultiFileDiff = lazy(async () => {
  const module = await import('@pierre/diffs/react');
  return { default: module.MultiFileDiff };
});

interface DiffOptions {
  diffStyle: 'split';
  diffIndicators: 'bars';
  lineDiffType: 'word-alt';
  overflow: 'scroll';
  themeType: Theme;
  disableFileHeader: boolean;
  collapsedContextThreshold: number;
}

export function GitDiffDialog({ theme }: { theme: Theme }) {
  const diff = useGitDiff();
  const [dialogReady, setDialogReady] = useState(false);
  const leftText = diff.left?.text;
  const rightText = diff.right?.text;
  const ready = leftText !== undefined && rightText !== undefined;
  const files = useMemo(
    () => comparisonFiles(diff.left, diff.right, leftText ?? '', rightText ?? ''),
    [diff.left, diff.right, leftText, rightText],
  );
  const renderKey = useMemo(
    () => `${sourceKey(diff.left)}:${sourceKey(diff.right)}`,
    [diff.left, diff.right],
  );
  const options = useMemo(
    () => ({
      diffStyle: 'split' as const,
      diffIndicators: 'bars' as const,
      lineDiffType: 'word-alt' as const,
      overflow: 'scroll' as const,
      themeType: theme,
      disableFileHeader: true,
      collapsedContextThreshold: 20,
    }),
    [theme],
  );
  const identical = ready && leftText === rightText;

  return (
    <Dialog
      open={diff.open}
      onOpenChange={(open) => {
        setGitDiffOpen(open);
        if (!open) setDialogReady(false);
      }}
      onOpenChangeComplete={setDialogReady}
    >
      <DialogContent className="flex h-[min(90vh,960px)] w-[min(96vw,1600px)] max-w-none flex-col gap-0 overflow-hidden bg-canvas p-0 text-body sm:max-w-none">
        <DialogHeader className="shrink-0 gap-1 border-b border-hairline px-5 py-4 pr-12">
          <div className="flex items-center gap-2">
            <Columns2 className="size-4 text-primary" aria-hidden />
            <DialogTitle className="text-ink">Git Diff</DialogTitle>
            {(diff.left !== undefined || diff.right !== undefined) && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="ml-auto text-muted-foreground"
                onClick={clearGitDiff}
              >
                <RotateCcw data-icon="inline-start" />
                Reset
              </Button>
            )}
          </div>
          <DialogDescription>
            Compare Markdown, XML, or JSON selected from Chat Trace and Inspector. Left is the old version; right is the new version.
          </DialogDescription>
        </DialogHeader>

        <div className="grid shrink-0 grid-cols-2 border-b border-hairline bg-surface-soft">
          <SourceSummary side="left" source={diff.left} />
          <SourceSummary side="right" source={diff.right} />
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-canvas">
          {!ready ? (
            <DiffEmptyState
              text={
                diff.left === undefined && diff.right === undefined
                  ? 'Choose Diff Left and Diff Right on a Markdown, XML, or JSON source.'
                  : `Choose a source for the ${diff.left === undefined ? 'left' : 'right'} side.`
              }
            />
          ) : !dialogReady ? (
            <DiffEmptyState text="Preparing diff…" />
          ) : identical ? (
            <div className="grid min-h-full min-w-0 grid-cols-2 divide-x divide-hairline bg-canvas">
              <IdenticalSource side="left" text={leftText} />
              <IdenticalSource side="right" text={rightText} />
            </div>
          ) : (
            <PreparedDiff renderKey={renderKey} files={files} options={options} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type PreparedState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; html: string }
  | { key: string; status: 'error' };

function PreparedDiff({
  renderKey,
  files,
  options,
}: {
  renderKey: string;
  files: ReturnType<typeof comparisonFiles>;
  options: DiffOptions;
}) {
  const [prepared, setPrepared] = useState<PreparedState>({ key: renderKey, status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setPrepared({ key: renderKey, status: 'loading' });
    void import('@pierre/diffs/ssr')
      .then(({ preloadMultiFileDiff }) =>
        preloadMultiFileDiff({
          oldFile: files.oldFile,
          newFile: files.newFile,
          options,
        }),
      )
      .then(
        ({ prerenderedHTML }) => {
          if (!cancelled) setPrepared({ key: renderKey, status: 'ready', html: prerenderedHTML });
        },
        () => {
          if (!cancelled) setPrepared({ key: renderKey, status: 'error' });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [files, options, renderKey]);

  if (prepared.key !== renderKey || prepared.status === 'loading') {
    return <DiffEmptyState text="Preparing diff…" />;
  }
  if (prepared.status === 'error') {
    return <DiffEmptyState text="Unable to prepare this diff." />;
  }

  return (
    <Suspense fallback={<DiffEmptyState text="Preparing diff…" />}>
      <LazyMultiFileDiff
        key={renderKey}
        oldFile={files.oldFile}
        newFile={files.newFile}
        options={options}
        prerenderedHTML={prepared.html}
        disableWorkerPool
        className="block min-w-full"
        style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px', lineHeight: 1.6 }}
      />
    </Suspense>
  );
}

function SourceSummary({ side, source }: { side: GitDiffSide; source?: GitDiffSource }) {
  const label = side === 'left' ? 'Diff Left · old' : 'Diff Right · new';
  return (
    <div className="flex min-w-0 items-center gap-3 border-r border-hairline px-4 py-2.5 last:border-r-0">
      <span className="shrink-0 text-[12px] font-medium tracking-[1px] text-muted-foreground uppercase">
        {label}
      </span>
      {source ? (
        <>
          <span
            className="min-w-0 flex-1 truncate font-mono text-[12px] text-body"
            title={`${source.sessionId} · ${source.label.toUpperCase()}`}
          >
            {source.sessionId} · {source.label.toUpperCase()}
          </span>
          <span className="shrink-0 rounded-sm bg-surface-card px-1.5 py-0.5 font-mono text-[10px] tracking-[0.5px] text-muted-foreground uppercase">
            {source.format}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-muted-soft">
            {source.text.split('\n').length} lines
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Clear ${label}`}
            onClick={() => clearGitDiffSide(side)}
          >
            <X />
          </Button>
        </>
      ) : (
        <span className="text-[12px] text-muted-soft italic">Not selected</span>
      )}
    </div>
  );
}

function IdenticalSource({ side, text }: { side: GitDiffSide; text: string }) {
  return (
    <div className="min-w-0 overflow-auto" aria-label={`Identical ${side} source`}>
      <pre className="w-max min-w-full p-3 font-mono text-[12.5px] leading-[1.6] whitespace-pre text-body-strong">
        {text}
      </pre>
    </div>
  );
}

function comparisonFiles(
  left: GitDiffSource | undefined,
  right: GitDiffSource | undefined,
  leftText: string,
  rightText: string,
) {
  const format = left?.format === right?.format ? left?.format : undefined;
  const extension = format === 'markdown' ? 'md' : (format ?? 'text');
  const language = format ?? 'text';
  return {
    oldFile: { name: `Diff.${extension}`, contents: leftText, lang: language },
    newFile: { name: `Diff.${extension}`, contents: rightText, lang: language },
  };
}

function sourceKey(source: GitDiffSource | undefined): string {
  if (!source) return 'empty';
  let hash = 0;
  for (let index = 0; index < source.text.length; index += 1) {
    hash = (hash * 31 + source.text.charCodeAt(index)) | 0;
  }
  return `${source.sourceId}:${source.format}:${hash}`;
}

function DiffEmptyState({ text }: { text: string }) {
  return (
    <div className="flex h-full min-h-52 items-center justify-center px-6 text-center text-[14px] text-muted-soft italic">
      {text}
    </div>
  );
}
