export const fmtNum = (v: number | null | undefined, digits = 0, unit = '') =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}${unit}`;

export function fmtAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

/** Deterministic colour per dispatcher id, so the same person has the same colour everywhere. */
export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 65% 55%)`;
}

export const truckLabel = (id: string, name?: string) => name ?? id.replace('truck_', 'Truck #');
