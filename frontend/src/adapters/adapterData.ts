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
  heldoutBase?: number; // exact-match share on a held-out set, 0..1 (from an `evaluated` adapter_event)
  heldoutCandidate?: number;
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

// `evaluated` (CONTRACT §6): candidate vs base exact matches on a held-out set, and the paired test's verdict.
export type EvalResult = {
  dataset: string;
  n: number;
  candidate: number;
  base: number;
  diff: number;
  ciLo: number;
  ciHi: number;
  p?: number;
  verdict: string;
};

export type AdapterEventMeta = { key?: string; event?: string; agentId?: bigint; weight?: number; result?: EvalResult };

export function adapterEventMeta(meta: string): AdapterEventMeta {
  try {
    const v = JSON.parse(meta) as Record<string, unknown>;
    return {
      key: typeof v.key === 'string' ? v.key : undefined,
      event: typeof v.event === 'string' ? v.event : undefined,
      agentId: typeof v.agent_id === 'number' ? BigInt(v.agent_id) : undefined,
      weight: num(v.weight),
      result: evalResult(v),
    };
  } catch {
    return {};
  }
}

function evalResult(v: Record<string, unknown>): EvalResult | undefined {
  const [n, candidate, base, diff, ciLo, ciHi] = [v.n, v.candidate, v.base, v.diff, v.ci_lo, v.ci_hi].map(num);
  if (v.event !== 'evaluated' || typeof v.verdict !== 'string' || !n || candidate === undefined || base === undefined)
    return undefined;
  return { dataset: String(v.dataset ?? ''), n, candidate, base, diff: diff ?? 0, ciLo: ciLo ?? 0, ciHi: ciHi ?? 0, p: num(v.p), verdict: v.verdict };
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
