import type { TrainStats } from './adapterData';

// Before/after pairs drawn as bars on one shared scale and baseline, never as loose numbers.
export function StatBars({ stats }: { stats: TrainStats }) {
  const rows: { label: string; a?: number; b?: number; fmt: (n: number) => string; better: 'lower' | 'higher' }[] = [
    { label: 'Judge', a: stats.judgeBefore, b: stats.judgeAfter, fmt: n => `${Math.round(n * 100)}%`, better: 'higher' },
    { label: 'Loss', a: stats.lossFirst, b: stats.lossLast, fmt: n => n.toFixed(3), better: 'lower' },
  ];
  const shown = rows.filter(r => r.a !== undefined && r.b !== undefined);
  if (!shown.length) return null;
  return (
    <div className="statbars">
      {shown.map(r => {
        const max = r.label === 'Judge' ? 1 : Math.max(r.a!, r.b!) || 1;
        return (
          <div key={r.label} className="statbar-group" role="group" aria-label={`${r.label}: ${r.fmt(r.a!)} before, ${r.fmt(r.b!)} after (${r.better} is better)`}>
            <span className="statbar-title">
              {r.label} <small>({r.better} is better)</small>
            </span>
            {(
              [
                ['before', r.a!],
                ['after', r.b!],
              ] as const
            ).map(([which, v]) => (
              <div key={which} className="statbar">
                <span className="statbar-which">{which}</span>
                <span className="statbar-track" aria-hidden="true">
                  <i className={`statbar-fill is-${which}`} style={{ width: `${Math.max(2, (v / max) * 100)}%` }} />
                </span>
                <span className="statbar-value">{r.fmt(v)}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
