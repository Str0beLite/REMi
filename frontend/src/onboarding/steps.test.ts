import { describe, expect, it } from 'vitest';
import { getStartedSteps } from './steps';

const node = { name: 'gpu-01', gpu: 'RTX 5070 Ti', status: 'up' };
const sleep = { name: 'sleep-remi', protected: true };
const oncall = { name: 'oncall', protected: false };

describe('getStartedSteps', () => {
  it('starts with nothing done, and asks for a node first', () => {
    const s = getStartedSteps([], [], []);
    expect(s.map(x => x.done)).toEqual([false, false, false]);
    expect(s[0].text).toContain('remi up');
  });

  it("ticks steps off from live data; Sleep REMi doesn't count as the first REMi, a down node doesn't count", () => {
    expect(getStartedSteps([{ ...node, status: 'down' }], [sleep], []).map(x => x.done)).toEqual([false, false, false]);
    const s = getStartedSteps([node], [sleep, oncall], [{ authorKind: 'user', kind: 'chat' }]);
    expect(s.map(x => x.done)).toEqual([true, true, false]);
    expect(s[0].text).toBe('gpu-01 is connected (RTX 5070 Ti)');
    expect(s[2].text).toBe('Say hi: mention @oncall here');
    expect(getStartedSteps([node], [oncall], [{ authorKind: 'agent', kind: 'chat' }])[2].done).toBe(true);
  });
});
