import { describe, expect, it } from 'vitest';
import { adapterEventMeta, parseStats, weightIn } from './adapterData';

describe('parseStats', () => {
  it("reads the trainer's stats and optional judge scores", () => {
    expect(parseStats('{"steps":120,"loss_first":2.14,"loss_last":0.61,"minutes":12.5,"examples":214}')).toMatchObject({
      steps: 120,
      lossFirst: 2.14,
      lossLast: 0.61,
      examples: 214,
    });
    expect(parseStats('{"judge_before":0.81,"judge_after":0.88}')).toMatchObject({ judgeBefore: 0.81, judgeAfter: 0.88 });
    expect(parseStats('nope')).toEqual({});
  });
});

describe('adapterEventMeta', () => {
  it('reads key, event, agent and weight', () => {
    expect(adapterEventMeta('{"key":"dc-ops@3","event":"attached","agent_id":2,"weight":0.6}')).toEqual({
      key: 'dc-ops@3',
      event: 'attached',
      agentId: 2n,
      weight: 0.6,
    });
  });
});

describe('weightIn', () => {
  const af = 'name: oncall\nadapters:\n  - {name: dc-ops, version: 3, weight: 0.6}\n';
  it('finds the adapter by name', () => {
    expect(weightIn(af, 'dc-ops')).toEqual({ name: 'dc-ops', version: 3, weight: 0.6 });
    expect(weightIn(af, 'other')).toBeUndefined();
    expect(weightIn('name: [', 'dc-ops')).toBeUndefined();
  });
});
