import type { TransportSummary } from '../core/types.js';
import type { TraceSection } from './trace-groups.js';

/** Extracts valid one-based exchange numbers while preserving first-entry order. */
export function parseTraceFilterNumbers(value: string): number[] {
  const numbers: number[] = [];
  const seen = new Set<number>();
  for (const match of value.matchAll(/\d+/g)) {
    const number = Number(match[0]);
    if (!Number.isSafeInteger(number) || number < 1 || seen.has(number)) continue;
    seen.add(number);
    numbers.push(number);
  }
  return numbers;
}

/** Canonical display form used after paste and when the field loses focus. */
export function formatTraceFilterInput(value: string): string {
  return parseTraceFilterNumbers(value)
    .map((number) => `#${number}`)
    .join(', ');
}

/** Completes the delimiter and primes the field for the next exchange number. */
export function completeTraceFilterInput(value: string): string {
  const formatted = formatTraceFilterInput(value);
  return formatted ? `${formatted}, #` : '#';
}

/**
 * Keeps the captured chronology. Query order intentionally has no influence:
 * "#11, #2" selects the same sections as "#2, #11" and both render #2 first.
 */
export function filterTraceSections(
  sections: readonly TraceSection[],
  transport: readonly TransportSummary[],
  numbers: readonly number[],
): TraceSection[] {
  if (numbers.length === 0) return [...sections];

  const wanted = new Set(numbers);
  const numberByRequestId = new Map(
    transport.flatMap((record) =>
      record.turnIndex === undefined
        ? []
        : [[record.id, record.turnIndex + 1] as const],
    ),
  );
  const matches = (requestId: string | undefined): boolean =>
    requestId !== undefined && wanted.has(numberByRequestId.get(requestId) ?? -1);

  return sections.flatMap<TraceSection>((section) => {
    if (section.type === 'exchange') {
      return matches(section.exchange.requestId) ? [section] : [];
    }
    const exchanges = section.exchanges.filter((exchange) => matches(exchange.requestId));
    return exchanges.length > 0 ? [{ ...section, exchanges }] : [];
  });
}
