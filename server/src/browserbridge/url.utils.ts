// Pure URL predicates for the terminal→app browser bridge.
// See docs/superpowers/specs/2026-07-17-terminal-browser-sync-design.md

/** True only for http(s) URLs — everything else (`open .`, `open file.txt`,
 *  `open -a App`, `file://…`) must be passed to the real opener untouched. */
export function isForwardableUrl(arg: string): boolean {
  if (!arg) return false;
  try {
    const u = new URL(arg);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** True only when the URL's host is loopback (the CLI's OAuth callback listener).
 *  A Tailscale IP (100.x) is deliberately NOT loopback. */
export function isLoopbackCallbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, ''); // strip [] from [::1]
    return LOOPBACK_HOSTS.has(host);
  } catch {
    return false;
  }
}
