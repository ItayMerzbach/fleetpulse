import { useState, type FormEvent } from 'react';
import { ALERT_MAX } from '../../domain/schemas';
import { ValidationError } from '../../transport/errors';
import { useConfirm, useToast } from '../components/Dialogs';
import { useFleetPulse } from '../context';
import type { DetailWidgetProps } from './registry';

export function AlertWidget({ truckId }: DetailWidgetProps) {
  const app = useFleetPulse();
  const toast = useToast();
  const confirm = useConfirm();
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<'info' | 'warning' | 'critical'>('info');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (severity === 'critical') {
      const ok = await confirm({
        title: 'Send critical alert?',
        body: <p>The driver of {truckId} will receive a CRITICAL alert: “{message.trim()}”.</p>,
        confirmLabel: 'Send critical alert',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await app.sendAlert(truckId, { message, severity });
      toast('success', `Alert sent to ${truckId}`);
      setMessage('');
    } catch (err) {
      setError(err instanceof ValidationError ? err.message : `Failed to send: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form form-inline" onSubmit={submit} noValidate>
      <input
        className="input"
        placeholder="Message to driver"
        value={message}
        maxLength={ALERT_MAX}
        onChange={(e) => setMessage(e.target.value)}
        aria-label="Alert message"
      />
      <select className="input" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)} aria-label="Severity">
        <option value="info">Info</option>
        <option value="warning">Warning</option>
        <option value="critical">Critical</option>
      </select>
      <button className="btn btn-sm" disabled={busy || !message.trim()}>
        Send
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
