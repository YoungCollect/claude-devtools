export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(
    d.getMilliseconds(),
  ).padStart(3, '0')}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Best-effort pretty JSON that never throws on odd values. */
export function pretty(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * A one-line gist of a tool's arguments for the collapsed trace row —
 * `Bash(ls -la)` reads far better than a truncated JSON blob.
 */
export function summarizeToolInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return truncate(String(input ?? ''), 90);
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return truncate(value.replace(/\s+/g, ' '), 90);
  }
  const keys = Object.keys(record);
  if (keys.length === 0) return '';
  return truncate(keys.map((k) => `${k}=${shortValue(record[k])}`).join(' '), 90);
}

/** Tool results arrive as a string or a block array; flatten either to text. */
export function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result
      .map((block) => {
        if (typeof block === 'string') return block;
        const record = block as Record<string, unknown>;
        if (typeof record?.text === 'string') return record.text;
        return `[${String(record?.type ?? 'block')}]`;
      })
      .join('\n');
  }
  return pretty(result);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function shortValue(value: unknown): string {
  if (typeof value === 'string') return truncate(value.replace(/\s+/g, ' '), 24);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value && typeof value === 'object') return '{…}';
  return String(value);
}
