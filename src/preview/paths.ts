/**
 * The file layout of a static preview build.
 *
 * A preview is the same SPA with its API replaced by a directory of JSON that
 * a dumb file server can hand out. Both ends of that contract live here: the
 * Node generator (`src/preview/build.ts`) writes these paths and the browser
 * client (`src/web/preview-source.ts`) reads them. Keeping the naming in one
 * isomorphic module is what lets the browser resolve a file without first
 * downloading a manifest to look the name up in.
 *
 * Nothing in here may import Node or DOM APIs.
 */

import { fingerprint } from '../core/fingerprint.js';
import type { StateSnapshot } from '../core/types.js';

/** Directory, relative to the site root, holding every baked payload. */
export const PREVIEW_DIR = 'preview-data';

/** The snapshot every preview session starts from: config plus store state. */
export const PREVIEW_INDEX_FILE = `${PREVIEW_DIR}/index.json`;

/**
 * Ids that are safe to spell directly as a file name.
 *
 * Today's ids are `conv_<n>` and UUIDs, both of which pass. The check is here
 * for the ones that come later: an id carrying `/`, `..`, or a character a
 * static host treats specially would otherwise write outside the output
 * directory or produce a URL the browser cannot ask for.
 */
const PLAIN_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * File-name stem for an id. Deterministic, so the browser derives the same
 * name the generator wrote without consulting an index.
 */
export function previewFileStem(id: string): string {
  return PLAIN_ID.test(id) ? id : `h_${fingerprint(id)}`;
}

export function previewNodesFile(conversationId: string): string {
  return `${PREVIEW_DIR}/nodes/${previewFileStem(conversationId)}.json`;
}

export function previewTransportFile(transportId: string): string {
  return `${PREVIEW_DIR}/transport/${previewFileStem(transportId)}.json`;
}

/**
 * What the preview's `index.json` holds.
 *
 * `config` mirrors `GET /api/config` and `state` mirrors `GET /api/state`, so
 * the UI's first paint needs exactly one request either way. Node lists and
 * transport bodies stay in their own files: a captured session's bodies run to
 * megabytes, and a preview visitor should download only the request they open.
 */
export interface PreviewIndex {
  /** ISO timestamp of the build, shown in the preview banner. */
  generatedAt: string;
  /** Human label for where this capture came from, e.g. the db file name. */
  source: string;
  config: {
    proxyUrl: string;
    upstream: string;
    uiPort: number;
  };
  state: StateSnapshot;
}
