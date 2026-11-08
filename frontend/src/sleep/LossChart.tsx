import { useState, type PointerEvent } from 'react';
import { niceTicks, type LossPoint } from './sleepData';

const W = 640;
const H = 240;
const M = { top: 16, right: 56, bottom: 30, left: 44 };

// Training loss over steps: one series, one axis, recessive grid, the latest point labelled, hover crosshair.
export function LossChart({ points, label }: { points: LossPoint[]; label: string }) {
  const [hover, setHover] = useState<number>();
  if (points.length === 0) {
    return <p className="chart-empty">No training steps yet. The curve draws here live while Sleep REMi trains.</p>;
  }

  const steps = points.map(p => p.step);
  const losses = points.map(p => p.loss);
  const yTicks = niceTicks(Math.min(0, Math.min(...losses)), Math.max(...losses));
  const [y0, y1] = [yTicks[0], yTicks.at(-1)!];
  const [x0, x1] = [Math.min(...steps), Math.max(...steps, Math.min(...steps) + 1)];
  const xTicks = niceTicks(x0, x1, 5).filter(v => v >= x0 && v <= x1);
  const x = (s: number) => M.left + ((s - x0) / (x1 - x0)) * (W - M.left - M.right);
  const y = (l: number) => M.top + (1 - (l - y0) / (y1 - y0)) * (H - M.top - M.bottom);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.step).toFixed(1)},${y(p.loss).toFixed(1)}`).join('');
  const last = points.at(-1)!;
  const shown = hover !== undefined ? points[hover] : undefined;

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(points[i].step) - sx) < Math.abs(x(points[best].step) - sx)) best = i;
    setHover(best);
  }

  return (
    <figure className="loss">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: loss ${points[0].loss.toFixed(3)} to ${last.loss.toFixed(3)} over ${points.length} logged steps`} onPointerMove={onMove} onPointerLeave={() => setHover(undefined)}>
        {yTicks.map(t => (
          <g key={`y${t}`}>
            <line className="grid" x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
            <text className="tick" x={M.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">
              {t}
            </text>
          </g>
        ))}
        {xTicks.map(t => (
          <text key={`x${t}`} className="tick" x={x(t)} y={H - M.bottom + 18} textAnchor="middle">
            {t}
          </text>
        ))}
        <text className="tick" x={W - M.right} y={H - 4} textAnchor="end">
          step
        </text>
        <path className="line" d={path} />
        <circle className="end" cx={x(last.step)} cy={y(last.loss)} r={4} />
        <text className="end-label" x={x(last.step) + 8} y={y(last.loss)} dominantBaseline="middle">
          {last.loss.toFixed(3)}
        </text>
        {shown && (
          <g className="hover" pointerEvents="none">
            <line x1={x(shown.step)} x2={x(shown.step)} y1={M.top} y2={H - M.bottom} />
            <circle cx={x(shown.step)} cy={y(shown.loss)} r={5} />
          </g>
        )}
        <rect x={M.left} y={M.top} width={W - M.left - M.right} height={H - M.top - M.bottom} fill="transparent" />
      </svg>
      {shown && (
        <div className="loss-tip" style={{ left: `${(x(shown.step) / W) * 100}%` }} role="status">
          step <b>{shown.step}</b> · loss <b>{shown.loss.toFixed(3)}</b>
        </div>
      )}
      <figcaption>
        {label} · {points[0].loss.toFixed(3)} → {last.loss.toFixed(3)} over {points.length} logged steps
      </figcaption>
    </figure>
  );
}
