import type { DispatcherIdentity } from './types';

/**
 * Dispatcher ids are generated client-side as "<name-slug>-<4 hex>".
 *
 * Why client-side: the id must be stable across WebSocket reconnects (so the
 * audit trail and presence don't fragment) and must exist before the first
 * REST call (X-Dispatcher-Id header). Why embed the name: the server only
 * broadcasts names in dispatcher_joined, which dispatchers that were already
 * online before us never receive — the slug lets everyone render a readable
 * "who" for audit entries and 409 conflicts without a lookup endpoint.
 */
export function createDispatcherIdentity(name: string, random: () => number = Math.random): DispatcherIdentity {
  const slug =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20) || 'dispatcher';
  const suffix = Math.floor(random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return { id: `${slug}-${suffix}`, name: name.trim() };
}

export function displayNameFromId(id: string): string {
  const m = /^([a-z0-9_]+)-[0-9a-f]{4}$/.exec(id);
  if (!m) return id;
  return m[1]
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

const SESSION_KEY = 'fleetpulse.dispatcher';

/** sessionStorage (not localStorage) so two tabs = two dispatchers, as the brief suggests for testing. */
export function loadIdentity(storage: Storage | undefined = globalThis.sessionStorage): DispatcherIdentity | null {
  try {
    const raw = storage?.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.id === 'string' && typeof parsed?.name === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveIdentity(identity: DispatcherIdentity, storage: Storage | undefined = globalThis.sessionStorage) {
  try {
    storage?.setItem(SESSION_KEY, JSON.stringify(identity));
  } catch {
    /* private mode — identity just won't survive reload */
  }
}

export function clearIdentity(storage: Storage | undefined = globalThis.sessionStorage) {
  try {
    storage?.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}
