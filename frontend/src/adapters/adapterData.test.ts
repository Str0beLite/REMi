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

  it('reads an evaluated result, and ignores one with missing numbers', () => {
    const meta =
      '{"key":"sre@2","event":"evaluated","dataset":"held-out","n":10,"candidate":10,"base":0,"diff":100,"ci_lo":100,"ci_hi":100,"p":0.00195,"verdict":"STRONG GO"}';
    expect(adapterEventMeta(meta).result).toEqual({
      dataset: 'held-out',
      n: 10,
      candidate: 10,
      base: 0,
      diff: 100,
      ciLo: 100,
      ciHi: 100,
      p: 0.00195,
      verdict: 'STRONG GO',
    });
    expect(adapterEventMeta('{"key":"sre@2","event":"evaluated","verdict":"NO-GO"}').result).toBeUndefined();
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
