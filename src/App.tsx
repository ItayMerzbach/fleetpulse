import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createFleetPulse, type FleetPulse } from './app/createFleetPulse';
import { config } from './config';
import { clearIdentity, createDispatcherIdentity, loadIdentity, saveIdentity } from './domain/dispatcher';
import { DispatcherNameSchema } from './domain/schemas';
import type { DispatcherIdentity } from './domain/types';
import { BottomPanel } from './ui/components/BottomPanel';
import { DetailPanel } from './ui/components/DetailPanel';
import { ConfirmProvider, Modal, ToastProvider } from './ui/components/Dialogs';
import { ErrorBoundary } from './ui/components/ErrorBoundary';
import { FleetList } from './ui/components/FleetList';
import { FleetMap } from './ui/components/FleetMap';
import { Header } from './ui/components/Header';
import { RouteActionsProvider } from './ui/components/RouteActions';
import { FleetPulseProvider, useFleetPulse, useStore } from './ui/context';
import { useTruckRows } from './ui/hooks/useFleetView';
import { SHORTCUTS, useKeyboardShortcuts } from './ui/hooks/useKeyboardShortcuts';

export default function App() {
  const [identity, setIdentity] = useState<DispatcherIdentity | null>(() => loadIdentity());
  if (!identity) {
    return (
      <Login
        onLogin={(id) => {
          saveIdentity(id);
          setIdentity(id);
        }}
      />
    );
  }
  return (
    <Session
      key={identity.id}
      identity={identity}
      onSignOut={() => {
        clearIdentity();
        setIdentity(null);
      }}
    />
  );
}

function Login({ onLogin }: { onLogin: (id: DispatcherIdentity) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = DispatcherNameSchema.safeParse(name);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Invalid name');
    onLogin(createDispatcherIdentity(parsed.data));
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit} noValidate>
        <h1>🚛 FleetPulse</h1>
        <p className="muted">Identify yourself so other dispatchers can see who changed what.</p>
        <input className="input" autoFocus placeholder="Your name" value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary">Start dispatching</button>
        <p className="muted small">Tip: open a second tab and sign in with another name to test multi-dispatcher conflicts.</p>
      </form>
    </div>
  );
}

/** Owns the FleetPulse instance lifecycle (created on mount, fully torn down on unmount). */
function Session({ identity, onSignOut }: { identity: DispatcherIdentity; onSignOut: () => void }) {
  const [app, setApp] = useState<FleetPulse | null>(null);
  useEffect(() => {
    const instance = createFleetPulse({ apiBaseUrl: config.apiBaseUrl, wsUrl: config.wsUrl, identity });
    instance.start();
    setApp(instance);
    return () => instance.stop();
  }, [identity]);

  if (!app) return null;
  return (
    <FleetPulseProvider app={app}>
      <ToastProvider>
        <ConfirmProvider>
          <RouteActionsProvider>
            <Dashboard onSignOut={onSignOut} />
          </RouteActionsProvider>
        </ConfirmProvider>
      </ToastProvider>
    </FleetPulseProvider>
  );
}

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const app = useFleetPulse();
  const rows = useTruckRows();
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const getRows = useCallback(() => rowsRef.current, []);
  useKeyboardShortcuts(app, getRows);
  const showHelp = useStore(app.stores.ui, (s) => s.showHelp);
  const source = useStore(app.stores.fleet, (s) => s.source);

  return (
    <div className="layout">
      <Header onSignOut={onSignOut} />
      {source.mode === 'degraded' && (
        <div className="banner banner-warn" role="status">
          ⚠ Fleet API is unavailable — showing cached fleet data (stale). Live positions continue via telemetry. {source.error}
        </div>
      )}
      {source.mode === 'error' && (
        <div className="banner banner-bad" role="alert">
          Fleet API unreachable and no cached data. Live telemetry is shown where available.{' '}
          <button className="btn btn-xs" onClick={() => void app.fleet.sync()}>
            Retry now
          </button>
        </div>
      )}
      <main className="main">
        <ErrorBoundary name="Fleet list">
          <FleetList />
        </ErrorBoundary>
        <ErrorBoundary name="Map">
          <FleetMap />
        </ErrorBoundary>
        <ErrorBoundary name="Vehicle detail">
          <DetailPanel />
        </ErrorBoundary>
      </main>
      <ErrorBoundary name="Panels">
        <BottomPanel />
      </ErrorBoundary>
      {showHelp && (
        <Modal title="Keyboard shortcuts" onClose={() => app.stores.ui.setState((u) => ({ ...u, showHelp: false }))}>
          <table className="table">
            <tbody>
              {SHORTCUTS.map(([k, d]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td>{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
