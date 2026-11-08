import type { TrainStats } from './adapterData';

// Before/after pairs drawn as bars on one shared scale and baseline, never as loose numbers.
export function StatBars({ stats }: { stats: TrainStats }) {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const rows: { label: string; a?: number; b?: number; fmt: (n: number) => string; better: 'lower' | 'higher'; share?: boolean; names?: [string, string] }[] = [
    { label: 'Exact match on unseen examples', a: stats.heldoutBase, b: stats.heldoutCandidate, fmt: pct, better: 'higher', share: true, names: ['base', 'with it'] },
    { label: 'Judge', a: stats.judgeBefore, b: stats.judgeAfter, fmt: pct, better: 'higher', share: true },
    { label: 'Loss', a: stats.lossFirst, b: stats.lossLast, fmt: n => n.toFixed(3), better: 'lower' },
  ];
  const shown = rows.filter(r => r.a !== undefined && r.b !== undefined);
  if (!shown.length) return null;
  return (
    <div className="statbars">
      {shown.map(r => {
        // A longer bar always means better: lower-is-better rows draw best/value, so the lowest loss is the full bar.
        const max = r.share ? 1 : Math.max(r.a!, r.b!) || 1;
        const min = Math.min(r.a!, r.b!);
        const width = (v: number) => (r.better === 'lower' ? (v > 0 ? min / v : 1) : v / max);
        const [before, after] = r.names ?? ['before', 'after'];
        return (
          <div key={r.label} className="statbar-group" role="group" aria-label={`${r.label}: ${r.fmt(r.a!)} ${before}, ${r.fmt(r.b!)} ${after} (${r.better} is better)`}>
            <span className="statbar-title">
              {r.label} <small>({r.better} is better)</small>
            </span>
            {(
              [
                ['before', before, r.a!],
                ['after', after, r.b!],
              ] as const
            ).map(([which, name, v]) => (
              <div key={which} className="statbar">
                <span className="statbar-which">{name}</span>
                <span className="statbar-track" aria-hidden="true">
                  <i className={`statbar-fill is-${which}`} style={{ width: `${Math.max(2, width(v) * 100)}%` }} />
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
