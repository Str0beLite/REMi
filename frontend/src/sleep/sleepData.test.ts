import { describe, expect, it } from 'vitest';
import { niceTicks, sleepState, type SleepMsg } from './sleepData';

let n = 0n;
const ev = (meta: object, body = '', kind = 'sleep_event'): SleepMsg => ({
  id: ++n,
  kind,
  body,
  meta: JSON.stringify(meta),
  ts: { microsSinceUnixEpoch: n * 1_000_000n },
});

describe('sleepState', () => {
  it('takes the loss points of the latest run only', () => {
    const msgs = [
      ev({ phase: 'asleep', spec: 'old' }),
      ev({ phase: 'training', step: 1, loss: 9 }),
      ev({ phase: 'wake' }),
      ev({ phase: 'night' }),
      ev({ phase: 'asleep', spec: 'dc-ops' }),
      ev({ phase: 'training', step: 10, loss: 2.1 }),
      ev({ phase: 'training', step: 20, loss: 1.4 }),
      ev({ kind: 'x' }, 'chat', 'chat'),
    ];
    const s = sleepState(msgs);
    expect(s.points).toEqual([
      { step: 10, loss: 2.1 },
      { step: 20, loss: 1.4 },
    ]);
    expect(s.spec).toBe('dc-ops');
    expect(s.phase).toBe('training');
  });

  it('finds the wake report and tolerates bad meta', () => {
    const s = sleepState([ev({ phase: 'asleep' }), { ...ev({}), meta: 'nope' }, ev({ phase: 'report' }, 'wake report: ok')]);
    expect(s.report?.body).toBe('wake report: ok');
    expect(s.phase).toBe('report');
  });

  it('is empty before any sleep', () => {
    expect(sleepState([])).toMatchObject({ phase: undefined, points: [] });
  });
});

describe('niceTicks', () => {
  it('covers the range with round steps', () => {
    expect(niceTicks(0.6, 2.1)).toEqual([0.5, 1, 1.5, 2, 2.5]);
    expect(niceTicks(1, 1)).toEqual([1]);
  });
});
