import { memo } from 'react';
import type { HistoryPoint } from '../../domain/types';

interface Props {
  points: HistoryPoint[];
  field: 'speed' | 'fuel' | 'engineTemp';
  min: number;
  max: number;
  threshold?: { value: number; label: string };
  width?: number;
  height?: number;
  label: string;
}

/**
 * Hand-rolled SVG line: x = EVENT time (so late points land where they belong),
 * null values (rejected sensor readings) render as gaps instead of fake zeros.
 */
export const Sparkline = memo(function Sparkline({ points, field, min, max, threshold, width = 280, height = 56, label }: Props) {
  if (points.length < 2) return <div className="spark-empty muted small">collecting data…</div>;
  const t0 = points[0].timestamp;
  const t1 = points[points.length - 1].timestamp;
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => ((t - t0) / span) * width;
  const y = (v: number) => height - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * height;

  let d = '';
  let pen = false;
  for (const p of points) {
    const v = p[field];
    if (v === null) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${x(p.timestamp).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  }
  const gaps = points.filter((p) => p[field] === null);

  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {threshold && (
        <>
          <line x1={0} x2={width} y1={y(threshold.value)} y2={y(threshold.value)} className="spark-threshold" />
          <text x={width - 2} y={y(threshold.value) - 2} textAnchor="end" className="spark-threshold-label">
            {threshold.label}
          </text>
        </>
      )}
      {gaps.map((p) => (
        <line key={p.timestamp} x1={x(p.timestamp)} x2={x(p.timestamp)} y1={0} y2={height} className="spark-gap" />
      ))}
      <path d={d} className="spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
});
