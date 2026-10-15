import { useState, type FormEvent } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FleetMap } from './components/FleetMap';
import { RoutesPanel } from './components/RoutesPanel';
import { TruckDetail } from './components/TruckDetail';
import { TruckList } from './components/TruckList';
import { createDispatcherId } from './presence';
import { useFleetPulse, type Identity } from './useFleetPulse';

// sessionStorage (not localStorage): each browser tab is a separate dispatcher.
const STORAGE_KEY = 'fleetpulse.identity';

export default function App() {
  const [identity, setIdentity] = useState<Identity | null>(() => JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null'));

  if (!identity) {
    return (
      <Login
        onLogin={(name) => {
          const id = { id: createDispatcherId(name), name };
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify(id));
          setIdentity(id);
        }}
      />
    );
  }
  return <Dashboard identity={identity} />;
}

function Login({ onLogin }: { onLogin: (name: string) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 30) return setError('Name must be 2–30 characters');
    onLogin(trimmed);
  }

  return (
    <form className="login" onSubmit={submit}>
      <h2>FleetPulse</h2>
      <input autoFocus placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
      <button>Start</button>
      {error && <p className="bad">{error}</p>}
    </form>
  );
}

function Dashboard({ identity }: { identity: Identity }) {
  const fp = useFleetPulse(identity);
  const others = Object.values(fp.presence.others);

  return (
    <div className="layout">
      <header>
        <b>FleetPulse</b>
        <span>
          You: {identity.name} · telemetry {fp.connected.telemetry ? '🟢' : '🔴'} · dispatch {fp.connected.dispatch ? '🟢' : '🔴'}
        </span>
        <span>
          Online:{' '}
          {others.length === 0
            ? 'only you'
            : others.map((d) => `${d.name}${d.viewingTruckId ? ` (viewing ${fp.truckNames[d.viewingTruckId] ?? d.viewingTruckId})` : ''}`).join(', ')}
        </span>
      </header>
      {fp.fleetError && <div className="bad banner">{fp.fleetError}</div>}
      <main>
        <ErrorBoundary name="Truck list">
          <TruckList fp={fp} />
        </ErrorBoundary>
        <ErrorBoundary name="Map">
          <FleetMap fp={fp} />
        </ErrorBoundary>
        <ErrorBoundary name="Truck detail">
          <TruckDetail fp={fp} />
        </ErrorBoundary>
      </main>
      <ErrorBoundary name="Routes">
        <RoutesPanel fp={fp} />
      </ErrorBoundary>
    </div>
  );
}
