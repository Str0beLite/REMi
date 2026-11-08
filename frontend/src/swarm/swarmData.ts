// Swarm rail data: the slice of CONTRACT.md §3 `node` / `agent` / `message` rows the rail reads,
// plus the training band derived from §6 `sleep_event` messages. Callers map generated bindings onto these.
import type { AgentStatus, Headgear } from '../components/remiLook';

export type SwarmNode = { id: bigint; name: string; gpu: string; status: string };
export type SwarmAgent = {
  id: bigint;
  name: string;
  status: AgentStatus;
  node_id: bigint;
  purpose: string;
  protected: boolean;
  headgear?: Headgear;
  tint?: string;
};
export type SwarmMessage = {
  id: bigint;
  author_kind: string;
  author_id: string;
  kind: string;
  meta: string;
  channel_id?: bigint;
  ts?: number; // ms since epoch
};
export type Activity = { label: string; channel_id?: bigint; ts?: number; needsHelp: boolean };
export type Training = { spec: string; step?: number };

export const UNIT_HEIGHT = 2; // each REMi takes a 2U plate
export const MIN_UNITS = 8;

// Latest sleep_event per node; a band shows while that phase is `training`. Agent-authored events map through
// the agent's node. The runtime's sleep cycle posts as `system`, so those map to every node that is asleep
// (the cycle sets its node asleep while it trains).
export function trainingByNode(messages: SwarmMessage[], agents: SwarmAgent[], nodes: SwarmNode[] = []): Map<bigint, Training> {
  const nodeOf = new Map(agents.map(a => [a.id.toString(), a.node_id] as const));
  const asleep = nodes.filter(n => n.status === 'asleep').map(n => n.id);
  const latest = new Map<bigint, { id: bigint; meta: Record<string, unknown> }>();
  for (const m of messages) {
    if (m.kind !== 'sleep_event') continue;
    const targets = m.author_kind === 'agent' ? [nodeOf.get(m.author_id)] : m.author_kind === 'system' ? asleep : [];
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(m.meta);
    } catch {
      continue;
    }
    for (const node of targets) {
      if (node === undefined) continue;
      const prev = latest.get(node);
      if (!prev || m.id > prev.id) latest.set(node, { id: m.id, meta });
    }
  }
  const out = new Map<bigint, Training>();
  for (const [node, { meta }] of latest) {
    if (meta.phase !== 'training') continue;
    out.set(node, {
      spec: typeof meta.spec === 'string' ? meta.spec : 'adapter',
      step: typeof meta.step === 'number' ? meta.step : undefined,
    });
  }
  return out;
}

// What each REMi did last (CONTRACT.md §6 kinds), so a plate says what it is doing, not just that it exists.
export function activityByAgent(messages: SwarmMessage[]): Map<string, Activity> {
  const out = new Map<string, Activity>();
  for (const m of messages) {
    if (m.author_kind !== 'agent') continue;
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(m.meta) ?? {};
    } catch {
      /* label from kind alone */
    }
    const cmd = typeof meta.command === 'string' ? meta.command : 'a tool';
    const label =
      m.kind === 'tool_call' ? `ran ${cmd}`
      : m.kind === 'tool_result' ? (typeof meta.exit_code === 'number' && meta.exit_code !== 0 ? `${cmd} failed (exit ${meta.exit_code})` : `${cmd} finished`)
      : m.kind === 'help_request' ? 'needs help'
      : m.kind === 'tool_card' ? 'proposed a tool'
      : m.kind === 'adapter_event' ? `adapter ${typeof meta.event === 'string' ? meta.event : 'changed'}`
      : m.kind === 'sleep_event' ? `sleep: ${typeof meta.phase === 'string' ? meta.phase : 'cycle'}`
      : 'replied';
    // messages arrive sorted by id, so the last one wins
    out.set(m.author_id, { label, channel_id: m.channel_id, ts: m.ts, needsHelp: m.kind === 'help_request' });
  }
  return out;
}

export function ago(ts: number, now: number) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

// Sample data for running the rail without SpacetimeDB (labelled as sample in the UI by the caller).
export const SAMPLE = {
  nodes: [
    { id: 1n, name: 'gpu-01', gpu: 'RTX 5070 Ti', status: 'up' },
    { id: 2n, name: 'gpu-02', gpu: 'RTX 3060 Laptop', status: 'up' },
  ] satisfies SwarmNode[],
  agents: [
    { id: 1n, name: 'sleep-remi', status: 'asleep', node_id: 1n, purpose: 'Runs the nightly cycle', protected: true },
    { id: 2n, name: 'oncall', status: 'thinking', node_id: 1n, purpose: 'Power and thermal questions', protected: false, headgear: 'headset', tint: '#3e9c8f' },
    { id: 3n, name: 'toolsmith', status: 'idle', node_id: 2n, purpose: 'Builds tools for the others', protected: false, headgear: 'hardhat', tint: '#e2a93b' },
    { id: 4n, name: 'helpdesk', status: 'stopped', node_id: 2n, purpose: 'Ticket triage', protected: false, headgear: 'bow', tint: '#d9668e' },
  ] satisfies SwarmAgent[],
  messages: [
    { id: 10n, author_kind: 'agent', author_id: '1', kind: 'sleep_event', meta: '{"phase":"training","spec":"dc-ops-v4","step":120}' },
    { id: 11n, author_kind: 'agent', author_id: '2', kind: 'tool_call', meta: '{"run_id":4,"command":"ipmitool"}', channel_id: 2n },
    { id: 12n, author_kind: 'agent', author_id: '3', kind: 'help_request', meta: '{"run_id":5,"family":"net"}', channel_id: 1n },
  ] satisfies SwarmMessage[],
};
