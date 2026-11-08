// Reads the sleep cycle out of `sleep_event` messages (CONTRACT.md §6): night → asleep → training… → wake → report.

export type SleepMsg = { id: bigint; kind: string; body: string; meta: string; ts: { microsSinceUnixEpoch: bigint } };
export type SleepMeta = { phase?: string; spec?: string; step?: number; loss?: number; minutes?: number };
export type LossPoint = { step: number; loss: number };

export function sleepMeta(meta: string): SleepMeta {
  try {
    const v = JSON.parse(meta);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as SleepMeta) : {};
  } catch {
    return {};
  }
}

export type SleepState = {
  phase: string | undefined;
  spec: string | undefined;
  points: LossPoint[];
  report: SleepMsg | undefined;
  lastEvent: SleepMsg | undefined;
};

// The latest run: everything after the most recent `asleep` (or `night`, if training hasn't started).
export function sleepState(messages: readonly SleepMsg[]): SleepState {
  const events = messages.filter(m => m.kind === 'sleep_event').sort((a, b) => (a.id < b.id ? -1 : 1));
  const withMeta = events.map(m => ({ m, meta: sleepMeta(m.meta) }));
  let start = -1;
  for (let i = withMeta.length - 1; i >= 0; i--) {
    if (withMeta[i].meta.phase === 'asleep' || withMeta[i].meta.phase === 'night') {
      start = i;
      if (withMeta[i].meta.phase === 'asleep') break;
    }
  }
  const run = start >= 0 ? withMeta.slice(start) : [];
  const last = withMeta.at(-1);
  const points = run
    .filter(e => e.meta.phase === 'training' && typeof e.meta.step === 'number' && typeof e.meta.loss === 'number')
    .map(e => ({ step: e.meta.step!, loss: e.meta.loss! }));
  return {
    phase: last?.meta.phase,
    spec: run.find(e => e.meta.spec)?.meta.spec,
    points,
    report: [...run].reverse().find(e => e.meta.phase === 'report')?.m,
    lastEvent: last?.m,
  };
}

// Round axis ticks: 0, 0.5, 1… style steps covering [min, max].
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= raw) ?? raw;
  const out: number[] = [];
  const top = Math.ceil(max / step - 1e-9) * step;
  for (let v = Math.floor(min / step) * step; v <= top + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}
