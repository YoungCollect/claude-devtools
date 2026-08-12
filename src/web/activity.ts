import { useEffect, useState } from 'react';

/**
 * What the header's indicator reports, in the order of how bad it is to miss:
 *
 * - `offline` — the change feed is closed. The page has stopped updating and
 *   nothing else it shows can be trusted to be current.
 * - `ready` — connected to the local devtools server, no traffic through the
 *   proxy. The tool is armed and waiting for the agent to say something.
 * - `active` — an exchange is open through the proxy right now.
 *
 * Connection and traffic are separate facts and both matter, so the indicator
 * carries three states rather than folding them into one. Reporting only the
 * connection is what made the dot pulse all night with every agent closed: it
 * was answering "is the devtools server up", which stays true for as long as
 * the process runs.
 */
export type FeedStatus = 'offline' | 'ready' | 'active';

export function feedStatus(connected: boolean, trafficActive: boolean): FeedStatus {
  if (!connected) return 'offline';
  return trafficActive ? 'active' : 'ready';
}

/**
 * How long `active` outlasts the last open exchange.
 *
 * A turn is not one request. Claude Code interleaves short calls — token
 * counts, retries — around the streamed completion, with gaps of a few hundred
 * milliseconds between them, and mapping the indicator straight onto the count
 * makes it strobe through a single turn. The tail is short enough that the dot
 * still goes quiet within a couple of seconds of a turn actually ending.
 */
const LINGER_MS = 2000;

/**
 * `true` while exchanges are open, and for `lingerMs` after the last one ends.
 */
export function useTrafficActive(activeRequests: number, lingerMs: number = LINGER_MS): boolean {
  const [lingering, setLingering] = useState(false);

  useEffect(() => {
    if (activeRequests > 0) {
      setLingering(true);
      return;
    }
    const timer = setTimeout(() => setLingering(false), lingerMs);
    return () => clearTimeout(timer);
  }, [activeRequests, lingerMs]);

  return activeRequests > 0 || lingering;
}
