import { Search, X } from 'lucide-react';
import type { ChangeEvent, ClipboardEvent, KeyboardEvent } from 'react';
import {
  completeTraceFilterInput,
  formatTraceFilterInput,
  parseTraceFilterNumbers,
} from '../trace-filter.js';
import { cx } from './ui.js';

export interface TraceNumberFilterProps {
  value: string;
  onChange: (value: string) => void;
}

export function TraceNumberFilter({ value, onChange }: TraceNumberFilterProps) {
  const change = (event: ChangeEvent<HTMLInputElement>) => {
    // Keep editing permissive. Canonical formatting happens at explicit entry
    // boundaries so controlled updates never fight cursor movement.
    onChange(event.currentTarget.value.replaceAll('，', ',').replace(/#{2,}/g, '#'));
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const delimiter = event.key === ',' || event.key === '，' || event.key === ' ';
    if (event.key === 'Enter' || delimiter) {
      if (parseTraceFilterNumbers(value).length === 0 && event.key !== 'Enter') return;
      event.preventDefault();
      onChange(completeTraceFilterInput(value));
      return;
    }
    if (event.key !== '#') return;
    const end = value.trimEnd();
    if (end.endsWith('#')) {
      event.preventDefault();
    } else if (/\d$/.test(end)) {
      event.preventDefault();
      onChange(completeTraceFilterInput(value));
    }
  };

  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const pasted = event.clipboardData.getData('text');
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? start;
    const next = `${value.slice(0, start)}${pasted}${value.slice(end)}`;
    if (parseTraceFilterNumbers(next).length === 0) return;
    event.preventDefault();
    onChange(formatTraceFilterInput(next));
  };

  return (
    <div
      className={cx(
        'flex h-8 w-64 max-w-[46vw] shrink-0 items-center gap-2 rounded-lg border border-hairline bg-canvas px-2.5',
        'focus-within:border-primary focus-within:ring-1 focus-within:ring-primary',
      )}
    >
      <Search size={14} className="shrink-0 text-muted-soft" aria-hidden />
      <label htmlFor="trace-number-filter" className="sr-only">
        Filter Chat Trace by exchange number
      </label>
      <input
        id="trace-number-filter"
        value={value}
        onChange={change}
        onKeyDown={keyDown}
        onPaste={paste}
        onBlur={() => onChange(formatTraceFilterInput(value))}
        autoComplete="off"
        spellCheck={false}
        placeholder="#2, #11"
        className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-muted-soft"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear Chat Trace filter"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-soft transition-colors hover:bg-surface-soft hover:text-ink"
        >
          <X size={13} aria-hidden />
        </button>
      )}
    </div>
  );
}
