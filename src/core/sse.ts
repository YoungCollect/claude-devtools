import type { SseFrame } from './types.js';

/**
 * Incremental SSE frame parser.
 *
 * The proxy feeds it whatever chunk boundaries the network happens to produce,
 * so it must tolerate a frame split across chunks and several frames arriving
 * in one. It never buffers on behalf of the client — the client's bytes are
 * forwarded first, and a copy is pushed through here afterwards.
 */
export class SseParser {
  private buffer = '';

  /** Returns the frames completed by this chunk, timestamped with `t`. */
  push(chunk: string, t: number): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];

    // Frames are separated by a blank line; tolerate CRLF as well as LF.
    let sep = this.findSeparator();
    while (sep) {
      const raw = this.buffer.slice(0, sep.index);
      this.buffer = this.buffer.slice(sep.index + sep.length);
      const frame = parseFrame(raw, t);
      if (frame) frames.push(frame);
      sep = this.findSeparator();
    }
    return frames;
  }

  /** Flush a trailing frame that was not terminated by a blank line. */
  end(t: number): SseFrame[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }
    const frame = parseFrame(this.buffer, t);
    this.buffer = '';
    return frame ? [frame] : [];
  }

  private findSeparator(): { index: number; length: number } | undefined {
    const lf = this.buffer.indexOf('\n\n');
    const crlf = this.buffer.indexOf('\r\n\r\n');
    if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
    if (lf !== -1) return { index: lf, length: 2 };
    return undefined;
  }
}

function parseFrame(raw: string, t: number): SseFrame | undefined {
  if (!raw.trim()) return undefined;

  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // Per spec a single leading space after the colon is part of the framing.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  const dataText = dataLines.join('\n');
  let data: unknown;
  if (dataText && dataText !== '[DONE]') {
    try {
      data = JSON.parse(dataText);
    } catch {
      data = undefined;
    }
  }

  return { t, event, data, raw };
}
