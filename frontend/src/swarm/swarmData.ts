// Swarm rail data: the slice of CONTRACT.md §3 `node` / `agent` / `message` rows the rail reads,
// plus the training band derived from §6 `sleep_event` messages. Callers map generated bindings onto these.
import { parse } from 'yaml';
import type { AgentStatus, Headgear } from '../components/remiLook';

export type SwarmNode = { id: bigint; name: string; gpu: string; status: string; base_model?: string; stats?: string };
export type AdapterRef = { name: string; version: number; weight: number };
export type SwarmAgent = {
  id: bigint;
  name: string;
  status: AgentStatus;
  node_id: bigint;
  purpose: string;
  protected: boolean;
  headgear?: Headgear;
  tint?: string;
  adapters?: AdapterRef[];
  tools?: string[];
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

// CONTRACT.md §3 node.stats. `{}` (no GPU, old runtime, or not reported yet) and anything malformed -> undefined.
export type NodeStats = { vram_total_mb: number; vram_used_mb: number; vram_vllm_mb: number; lora_slots: number; loras: string[] };
export function parseStats(text?: string): NodeStats | undefined {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text ?? '{}');
  } catch {
    return undefined;
  }
  const nums = ['vram_total_mb', 'vram_used_mb', 'vram_vllm_mb', 'lora_slots'] as const;
  if (!v || nums.some(k => typeof v[k] !== 'number' || !Number.isFinite(v[k]) || (v[k] as number) < 0)) return undefined;
  if (!(v.vram_total_mb as number)) return undefined;
  const loras = Array.isArray(v.loras) ? v.loras.filter((x): x is string => typeof x === 'string') : [];
  return { ...(v as Omit<NodeStats, 'loras'>), loras };
}

// What an Agentfile equips a REMi with. Lenient: a malformed file shows no equipment rather than breaking the rail.
export function equipmentOf(agentfile: string): { adapters: AdapterRef[]; tools: string[] } {
  try {
    const v = parse(agentfile) as { adapters?: unknown; tools?: unknown };
    const tools = Array.isArray(v?.tools) ? v.tools.filter((t): t is string => typeof t === 'string') : [];
    const adapters = Array.isArray(v?.adapters)
      ? v.adapters.filter(
          (a): a is AdapterRef => !!a && typeof a.name === 'string' && typeof a.version === 'number' && typeof a.weight === 'number',
        )
      : [];
    return { adapters, tools };
  } catch {
    return { adapters: [], tools: [] };
  }
}

const live = (adapters: AdapterRef[] = []) => adapters.filter(a => a.weight > 0);

// A REMi's learned skills in words: "base model", "dc-ops v2", or "dc-ops v2 70% + net v1 30%".
export function skillLabel(adapters?: AdapterRef[]): string {
  const ads = live(adapters);
  if (!ads.length) return 'base model';
  if (ads.length === 1 && ads[0].weight === 1) return `${ads[0].name} v${ads[0].version}`;
  return ads.map(a => `${a.name} v${a.version} ${Math.round(a.weight * 100)}%`).join(' + ');
}

// A loaded LoRA slot in words. `name@v` reads as "name v2"; a mix reads as its parts ("dc-ops + net"),
// taken from a REMi that runs on it. A mix no REMi here uses keeps a short hash.
export function slotLabel(lora: string, users: SwarmAgent[]): { short: string; full: string } {
  const single = /^(.+)@(\d+)$/.exec(lora);
  if (single) return { short: `${single[1]} v${single[2]}`, full: `${single[1]} v${single[2]}` };
  const ads = live(users[0]?.adapters);
  if (ads.length) return { short: ads.map(a => a.name).join(' + '), full: skillLabel(ads) };
  return { short: `mix ${lora.replace(/^mix-/, '').slice(0, 6)}`, full: lora };
}

// vLLM model name for an Agentfile adapters list, as remi.contract.model_name() computes it (CONTRACT.md §9).
// undefined = the base model.
export async function modelName(adapters: AdapterRef[] = []): Promise<string | undefined> {
  const live = adapters.filter(a => a.weight > 0);
  if (!live.length) return undefined;
  if (live.length === 1 && live[0].weight === 1) return `${live[0].name}@${live[0].version}`;
  // Python's json.dumps writes floats with a decimal point (1.0); JS would write 1.
  const pyFloat = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));
  const canon = [...live]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version - b.version))
    .map(a => `{"name":${JSON.stringify(a.name)},"version":${a.version},"weight":${pyFloat(Math.round(a.weight * 100) / 100)}}`);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`[${canon.join(',')}]`));
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `mix-${hex.slice(0, 12)}`;
}

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
    {
      id: 1n,
      name: 'gpu-01',
      gpu: 'RTX 5070 Ti',
      status: 'up',
      base_model: 'nvidia/Nemotron-Nano-4B',
      stats: '{"vram_total_mb":16303,"vram_used_mb":14100,"vram_vllm_mb":12800,"lora_slots":4,"loras":["dc-ops@2"]}',
    },
    { id: 2n, name: 'gpu-02', gpu: 'RTX 3060 Laptop', status: 'up' },
  ] satisfies SwarmNode[],
  agents: [
    { id: 1n, name: 'sleep-remi', status: 'asleep', node_id: 1n, purpose: 'Runs the nightly cycle', protected: true, tools: ['say', 'sleep', 'dataset', 'adapter'] },
    { id: 2n, name: 'oncall', status: 'thinking', node_id: 1n, purpose: 'Power and thermal questions', protected: false, headgear: 'headset', tint: '#3e9c8f', adapters: [{ name: 'dc-ops', version: 2, weight: 1 }], tools: ['say', 'sh', 'registry:host_power'] },
    { id: 3n, name: 'toolsmith', status: 'idle', node_id: 2n, purpose: 'Builds tools for the others', protected: false, headgear: 'hardhat', tint: '#e2a93b', tools: ['say', 'sh', 'propose_tool'] },
    { id: 4n, name: 'helpdesk', status: 'stopped', node_id: 2n, purpose: 'Ticket triage', protected: false, headgear: 'bow', tint: '#d9668e' },
  ] satisfies SwarmAgent[],
  messages: [
    { id: 10n, author_kind: 'agent', author_id: '1', kind: 'sleep_event', meta: '{"phase":"training","spec":"dc-ops-v4","step":120}' },
    { id: 11n, author_kind: 'agent', author_id: '2', kind: 'tool_call', meta: '{"run_id":4,"command":"ipmitool"}', channel_id: 2n },
    { id: 12n, author_kind: 'agent', author_id: '3', kind: 'help_request', meta: '{"run_id":5,"family":"net"}', channel_id: 1n },
  ] satisfies SwarmMessage[],
};
