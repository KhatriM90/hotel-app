/**
 * Connection status for the property device (OPS-04, OPS-06). "Online" means the
 * API answered its health check, not merely that Wi-Fi is up.
 */
export type ConnectionState = 'online' | 'offline' | 'checking';

export async function probe(fetchImpl: typeof fetch = fetch, url = '/api/health', timeoutMs = 4000): Promise<ConnectionState> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  try {
    const res = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? 'online' : 'offline';
  } catch {
    return 'offline';
  }
}

export function label(state: ConnectionState): string {
  switch (state) {
    case 'online':
      return 'Connected';
    case 'offline':
      return 'Offline: nothing is being sent. Do not confirm room charges or payments.';
    default:
      return 'Checking connection…';
  }
}
