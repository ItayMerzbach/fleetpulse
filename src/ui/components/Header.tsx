import type { ConnectionStatus } from '../../transport/SseConnection';
import { useFleetPulse, useStore } from '../context';
import { colorFor, fmtAgo, initials } from '../format';
import { useNow } from '../hooks/useNow';

function Pill({ label, status, title }: { label: string; status: 'ok' | 'warn' | 'bad'; title?: string }) {
  return (
    <span className={`pill pill-${status}`} title={title}>
      <span className="dot" /> {label}
    </span>
  );
}

const connLevel = (s: ConnectionStatus) => (s === 'open' ? 'ok' : s === 'connecting' || s === 'reconnecting' ? 'warn' : 'bad');

export function Header({ onSignOut }: { onSignOut: () => void }) {
  const app = useFleetPulse();
  const conn = useStore(app.stores.connection, (s) => s);
  const source = useStore(app.stores.fleet, (s) => s.source);
  const others = useStore(app.stores.presence, (s) => s.others);
  const info = useStore(app.stores.fleet, (s) => s.info);
  const now = useNow(1000);

  const apiLevel = source.mode === 'live' ? 'ok' : source.mode === 'loading' ? 'warn' : 'bad';
  const apiLabel =
    source.mode === 'live'
      ? 'Fleet API'
      : source.mode === 'degraded'
        ? `Degraded · data ${fmtAgo(source.dataAsOf, now)}`
        : source.mode === 'loading'
          ? 'Loading fleet…'
          : 'Fleet API down';
  const probeIn = source.nextProbeAt ? Math.max(0, Math.round((source.nextProbeAt - now) / 1000)) : null;

  return (
    <header className="header">
      <div className="brand">
        🚛 FleetPulse <span className="muted">dispatch</span>
      </div>
      <div className="conn">
        <Pill label={`Telemetry ${conn.sse}`} status={connLevel(conn.sse)} title="SSE /api/telemetry/stream" />
        <Pill label={`Realtime ${conn.ws}`} status={connLevel(conn.ws)} title="WebSocket /ws (presence, routes)" />
        <Pill
          label={apiLabel + (source.breaker !== 'closed' ? ` · breaker ${source.breaker}${probeIn !== null ? ` · probe in ${probeIn}s` : ''}` : '')}
          status={apiLevel}
          title={source.error ?? `Last sync ${fmtAgo(source.lastSyncAt, now)}`}
        />
      </div>
      <div className="presence" aria-label="Dispatchers online">
        {Object.values(others).map((d) => (
          <span
            key={d.id}
            className="avatar"
            style={{ background: colorFor(d.id), opacity: now - d.lastSeenAt > 20_000 ? 0.5 : 1 }}
            title={`${d.name} — ${d.viewingTruckId ? `viewing ${info[d.viewingTruckId]?.name ?? d.viewingTruckId}` : 'not viewing a truck'} · active ${fmtAgo(d.lastSeenAt, now)}`}
          >
            {initials(d.name)}
          </span>
        ))}
        <span className="avatar avatar-self" style={{ background: colorFor(app.identity.id) }} title={`You: ${app.identity.name} (${app.identity.id})`}>
          {initials(app.identity.name)}
        </span>
        <span className="muted small">{Object.keys(others).length + 1} online</span>
      </div>
      <div className="header-actions">
        <button className="btn btn-sm" onClick={() => app.stores.ui.setState((u) => ({ ...u, showHelp: true }))} title="Keyboard shortcuts (?)">
          ⌨ ?
        </button>
        <button className="btn btn-sm" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}
