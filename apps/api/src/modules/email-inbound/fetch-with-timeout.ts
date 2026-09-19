/**
 * fetchWithTimeout — fetch() wrapper that enforces a hard timeout via
 * AbortSignal. Without it, a hung provider (Google 503, slow Graph
 * response) blocks the email poller loop indefinitely, starving every
 * other tenant in the system. With it, the call aborts cleanly after
 * `timeoutMs` and the outer `try/catch` in the service moves on.
 *
 * Uses the standard `AbortSignal.timeout()` (Node 17.3+), which is the
 * platform's blessed way to cancel a fetch. The default 15s matches
 * the SCOUT recommendation for Gmail/Outlook polling.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}
