import { redactHeaders } from '../core/redact.js';
import { assembleStreamResponse, inspectRequest } from '../core/adapters/index.js';
import type { TransportDetail, TransportRecord } from '../core/types.js';
import type { Persistence } from './persistence.js';

/**
 * Refills the bodies that were dropped from memory after the exchange finished.
 *
 * Only the Inspector needs them, and only for the one request being viewed —
 * which is exactly why they are not kept resident. A miss means retention has
 * since evicted the request; the metadata still renders.
 */
export function hydrate(
  record: TransportRecord,
  persistence: Pick<Persistence, 'loadBodies'> | undefined,
): TransportRecord {
  if (!record.bodiesOffloaded || !persistence) return record;
  const bodies = persistence.loadBodies(record.id);
  if (!bodies) return record;
  return { ...record, ...bodies };
}

/**
 * Shapes a record for the wire: masked headers plus derived timing.
 *
 * Lives here rather than in `api.ts` because the static preview build
 * (`src/preview/build.ts`) has to emit byte-identical payloads — a second
 * implementation would be a second place for the adapter seam to drift.
 */
export function presentRecord(record: TransportRecord): TransportDetail {
  const { startedAt, ttfbAt, firstTokenAt, endedAt } = record.timing;
  return {
    ...record,
    assembledResponse: assembleStreamResponse(record),
    requestInspection: inspectRequest(record),
    requestHeaders: redactHeaders(record.requestHeaders),
    responseHeaders: record.responseHeaders ? redactHeaders(record.responseHeaders) : undefined,
    derivedTiming: {
      totalMs: endedAt !== undefined ? endedAt - startedAt : undefined,
      ttfbMs: ttfbAt !== undefined ? ttfbAt - startedAt : undefined,
      firstTokenMs: firstTokenAt !== undefined ? firstTokenAt - startedAt : undefined,
      streamMs: endedAt !== undefined && ttfbAt !== undefined ? endedAt - ttfbAt : undefined,
      frameCount: record.sseFrames.length,
    },
  };
}
