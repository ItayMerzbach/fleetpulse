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
      <span>
        <i className="legend-batch">GPS +N</i> batch merged into path
      </span>
      {trailCount !== null && <span className="muted">selected path: {trailCount} fixes</span>}
      {note && <span className="text-warn">{note}</span>}
    </div>
  );
}
