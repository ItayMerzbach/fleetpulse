export function MapLegend({ trailCount, note }: { trailCount: number | null; note?: string }) {
  return (
    <div className="map-legend small">
      <span>
        <i className="status-dot status-active" /> active
      </span>
      <span>
        <i className="status-dot status-idle" /> idle
      </span>
      <span>
        <i className="status-dot status-maintenance" /> maintenance
      </span>
      <span>
        <i className="legend-fault" /> sensor issue
      </span>
      {trailCount !== null && <span className="muted">path: {trailCount} fixes (hollow = late/batched)</span>}
      {note && <span className="text-warn">{note}</span>}
    </div>
  );
}
