import { useMemo } from 'react';
import { useFleetPulse, useStore } from '../context';
import { fmtTime } from '../format';
import type { DetailWidgetProps } from './registry';

/** Audit trail scoped to this truck and any route it has carried. */
export function ActivityWidget({ truckId }: DetailWidgetProps) {
  const app = useFleetPulse();
  const audit = useStore(app.stores.audit, (s) => s);
  const anomalies = useStore(app.stores.anomalies, (s) => s.events);
  const routes = useStore(app.stores.routes, (s) => s.routes);

  const items = useMemo(() => {
    const routeIds = new Set(Object.values(routes).filter((r) => r.truckId === truckId).map((r) => r.id));
    const a = audit
      .filter((e) => e.truckId === truckId || (e.routeId && routeIds.has(e.routeId)))
      .map((e) => ({ id: e.id, ts: e.timestamp, text: e.summary, kind: 'audit' as const }));
    const b = anomalies
      .filter((e) => e.truckId === truckId && e.kind !== 'out_of_order')
      .map((e) => ({ id: e.id, ts: e.timestamp, text: e.message, kind: e.classification }));
    return [...a, ...b].sort((x, y) => y.ts - x.ts).slice(0, 25);
  }, [audit, anomalies, routes, truckId]);

  if (!items.length) return <p className="muted small">No activity yet for this truck.</p>;
  return (
    <ul className="log">
      {items.map((i) => (
        <li key={i.id} className={`log-${i.kind}`}>
          <time>{fmtTime(i.ts)}</time> {i.text}
        </li>
      ))}
    </ul>
  );
}
