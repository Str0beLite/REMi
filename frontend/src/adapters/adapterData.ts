// Read-side helpers for adapters: train_stats, adapter_event meta, and who uses which adapter at what weight.
import { parse } from 'yaml';

export type TrainStats = {
  steps?: number;
  lossFirst?: number;
  lossLast?: number;
  minutes?: number;
  examples?: number;
  judgeBefore?: number;
  judgeAfter?: number;
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function parseStats(text: string): TrainStats {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    return {
      steps: num(v.steps),
      lossFirst: num(v.loss_first),
      lossLast: num(v.loss_last),
      minutes: num(v.minutes),
      examples: num(v.examples),
      judgeBefore: num(v.judge_before),
      judgeAfter: num(v.judge_after),
    };
  } catch {
    return {};
  }
}

export type AdapterEventMeta = { key?: string; event?: string; agentId?: bigint; weight?: number };

export function adapterEventMeta(meta: string): AdapterEventMeta {
  try {
    const v = JSON.parse(meta) as Record<string, unknown>;
    return {
      key: typeof v.key === 'string' ? v.key : undefined,
      event: typeof v.event === 'string' ? v.event : undefined,
      agentId: typeof v.agent_id === 'number' ? BigInt(v.agent_id) : undefined,
      weight: num(v.weight),
    };
  } catch {
    return {};
  }
}

// An agent's weight for adapter `name` (any version), from its Agentfile; 0 when it doesn't use it.
export function weightIn(agentfile: string, name: string): { version: number; weight: number } | undefined {
  try {
    const doc = parse(agentfile) as { adapters?: { name: string; version: number; weight: number }[] };
    return doc?.adapters?.find(a => a.name === name);
  } catch {
    return undefined;
  }
}
