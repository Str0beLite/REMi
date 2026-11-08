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
export type SwarmMessage = { id: bigint; author_kind: string; author_id: string; kind: string; meta: string };
export type Training = { spec: string; step?: number };

export const UNIT_HEIGHT = 2; // each REMi takes a 2U plate
export const MIN_UNITS = 8;

// Latest sleep_event per node (via its authoring agent); a band shows while that phase is `training`.
export function trainingByNode(messages: SwarmMessage[], agents: SwarmAgent[]): Map<bigint, Training> {
  const nodeOf = new Map(agents.map(a => [a.id.toString(), a.node_id] as const));
  const latest = new Map<bigint, { id: bigint; meta: Record<string, unknown> }>();
  for (const m of messages) {
    if (m.kind !== 'sleep_event' || m.author_kind !== 'agent') continue;
    const node = nodeOf.get(m.author_id);
    if (node === undefined) continue;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(m.meta);
    } catch {
      continue;
    }
    const prev = latest.get(node);
    if (!prev || m.id > prev.id) latest.set(node, { id: m.id, meta });
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
  ] satisfies SwarmMessage[],
};
