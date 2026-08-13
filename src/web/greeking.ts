/**
 * Greeking: drawing text as bars that follow the source's own line lengths,
 * the way page-layout software renders type too small to read.
 *
 * This exists so a diff selection can be recognised without being displayed.
 * The bars carry enough shape to tell a 400-line system prompt from a two-line
 * user message, and to show at a glance that both sides of a diff are the same
 * document — but they carry no characters, so a selection can sit on screen
 * across conversations without putting captured prompt text there with it.
 *
 * Callers must never render the source text alongside these; the whole point of
 * the abstraction is that it is lossy.
 */

/** How many bars a thumbnail draws, however long the source is. */
const SAMPLE_LIMIT = 14;

/**
 * The line length that fills a bar completely.
 *
 * Widths are relative to the longest line actually sampled, so a document is
 * measured against itself and its shape survives at any scale. The floor stops
 * a source of very short lines — a stub context tag, a one-word answer — from
 * being stretched to full width just because nothing longer sits beside it.
 */
const MIN_REFERENCE = 40;

/** A bar too short to see reads as no bar at all, which would lose a line. */
const MIN_VISIBLE = 0.08;

/**
 * Bar widths for `text`, each a `0`–`1` share of the thumbnail's width.
 *
 * Lines are sampled at an even stride rather than taken from the head, so the
 * thumbnail stands for the whole document. Reading only the first fourteen
 * lines would draw two 500-line prompts identically whenever they shared an
 * opening paragraph — which, for prompts assembled from the same template, is
 * most of the time.
 *
 * A blank source line yields `0`: the caller still lays out a row for it, so
 * paragraph rhythm survives into the thumbnail and is a large part of what
 * makes two documents look different.
 */
export function greekLines(text: string, limit: number = SAMPLE_LIMIT): number[] {
  if (text === '' || limit <= 0) return [];

  const lines = text.split('\n');
  // A trailing newline ends the last line, it does not begin an empty one.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  const stride = Math.max(1, Math.ceil(lines.length / limit));
  const lengths: number[] = [];
  for (let index = 0; index < lines.length && lengths.length < limit; index += stride) {
    // Trailing whitespace is invisible in the rendered document, so it must not
    // lengthen the bar that stands in for it.
    lengths.push((lines[index] ?? '').trimEnd().length);
  }

  const reference = Math.max(MIN_REFERENCE, ...lengths);
  return lengths.map((length) =>
    length === 0 ? 0 : Math.max(MIN_VISIBLE, length / reference),
  );
}
