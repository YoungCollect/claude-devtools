import { spawn } from 'node:child_process';

/**
 * Putting the trace UI in front of you, instead of printing where to find it.
 *
 * `run` exists to collapse "start the capture, then start the agent" into one
 * command; the tab you were always going to open is the last manual step left
 * in that sequence. It is a convenience only — every failure here is swallowed,
 * because the banner has already printed the URL and a browser that will not
 * start is no reason to take the capture down with it.
 */

/**
 * Which command hands a URL to the desktop's default browser.
 *
 * Returned rather than executed so the platform mapping is assertable in a test
 * without a browser window opening on the machine running it.
 */
export function openCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { bin: string; args: string[] } {
  // `-g` keeps the terminal in front. Claude Code owns this terminal for the
  // rest of the session, so stealing focus at exactly the moment its prompt
  // appears would make the convenience cost a window switch to undo.
  if (platform === 'darwin') return { bin: 'open', args: ['-g', url] };
  // The empty string is `start`'s title argument; without it a quoted URL would
  // be read as the window title and nothing would open.
  if (platform === 'win32') return { bin: 'cmd', args: ['/c', 'start', '', url] };
  return { bin: 'xdg-open', args: [url] };
}

export interface OpenDecision {
  requested: boolean;
  /** False when the UI port answers with the API alone — no page to show. */
  uiIsServed: boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

/**
 * Whether opening a browser is a help or a nuisance in this environment.
 *
 * The unserved-UI case is the one worth spelling out: without a built bundle
 * the UI port answers with JSON, so opening it would show a raw API response
 * and read as a bug rather than as the missing build step it is.
 */
export function shouldOpenUi({ requested, uiIsServed, env, platform }: OpenDecision): boolean {
  if (!requested || !uiIsServed) return false;
  // CI runs `run` to exercise the capture, never to look at it, and the opener
  // on a headless agent either fails or blocks.
  if (env.CI) return false;
  // X11/Wayland is how a browser reaches a screen on Linux; with neither, this
  // is a container or an SSH session and `xdg-open` has nowhere to draw.
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

/**
 * Opens `url`, detached and silent.
 *
 * Detached and unref'd so the browser is not a child this process waits on or
 * kills: closing the capture with Ctrl-C must not close the window you opened
 * it to read. `stdio: 'ignore'` protects the same terminal contract the client
 * relies on — the opener has no business writing over Claude Code's output.
 */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const { bin, args } = openCommand(url, platform);
  try {
    const child = spawn(bin, args, { stdio: 'ignore', detached: true });
    // No browser, or no opener binary. The URL is already on screen.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Same answer as the error event, for the platforms that throw instead.
  }
}
