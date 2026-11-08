import { useEffect, useState } from 'react';
import { AGENT_STATUSES } from '../components/remiLook';
import { RemiRow } from './RemiRow';
import {
  activityByAgent,
  modelName,
  parseStats,
  slotLabel,
  trainingByNode,
  type Activity,
  type NodeStats,
  type SwarmAgent,
  type SwarmMessage,
  type SwarmNode,
  type Training,
} from './swarmData';
import './swarm.css';

type Channel = { id: bigint; name: string };
type Props = {
  nodes: SwarmNode[];
  agents: SwarmAgent[];
  messages?: SwarmMessage[];
  channels?: Channel[];
  onOpenChannel?: (id: bigint) => void;
  now?: number;
};

type RowCtx = {
  activity: Map<string, Activity>;
  channels: Channel[];
  now: number;
  onOpenChannel?: (id: bigint) => void;
  models: Map<string, string | undefined>; // agent id -> vLLM LoRA name (undefined = base model)
  openId: string | null;
  toggle: (id: string) => void;
};

// LoRA names need SHA-256 for mixes, which is async in the browser.
function useModelNames(agents: SwarmAgent[]) {
  const key = JSON.stringify(agents.map(a => [a.id.toString(), a.adapters ?? []]));
  const [models, setModels] = useState(new Map<string, string | undefined>());
  useEffect(() => {
    let live = true;
    const pairs = JSON.parse(key) as [string, SwarmAgent['adapters']][];
    void Promise.all(pairs.map(async ([id, ads]) => [id, await modelName(ads)] as const)).then(r => {
      if (live) setModels(new Map(r));
    });
    return () => {
      live = false;
    };
  }, [key]);
  return models;
}

// The swarm, node first: each machine's memory and LoRA slots, then the REMis it runs and the skills they carry.
// A REMi row opens in place for what it did last, its tools and adapters.
// Every REMi is on screen: ones whose node isn't registered (or is gone) are listed under "Not placed".
export function SwarmRail({ nodes, agents, messages = [], channels = [], onOpenChannel, now = Date.now() }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const training = trainingByNode(messages, agents, nodes);
  const ctx: RowCtx = {
    activity: activityByAgent(messages),
    channels,
    now,
    onOpenChannel,
    models: useModelNames(agents),
    openId,
    toggle: id => setOpenId(cur => (cur === id ? null : id)),
  };
  const nodeIds = new Set(nodes.map(n => n.id));
  const unplaced = agents.filter(a => !nodeIds.has(a.node_id));
  const helpCount = agents.filter(a => ctx.activity.get(a.id.toString())?.needsHelp).length;
  const counts = AGENT_STATUSES.map(s => [s, agents.filter(a => a.status === s).length] as const).filter(([, n]) => n > 0);

  return (
    <section className="swarm" aria-labelledby="swarm-title">
      <header className="swarm-head">
        <h2 id="swarm-title">Swarm</h2>
        <span className="swarm-count">
          {agents.length} {agents.length === 1 ? 'REMi' : 'REMis'} · {nodes.length} {nodes.length === 1 ? 'node' : 'nodes'}
        </span>
      </header>
      {(counts.length > 0 || helpCount > 0) && (
        <p className="swarm-summary">
          {helpCount > 0 && <span className="swarm-help">{helpCount} need{helpCount === 1 ? 's' : ''} help</span>}
          {counts.map(([s, n]) => (
            <span key={s} className={`swarm-stat status-${s}`}>
              <i aria-hidden="true" className="swarm-dot" />
              {n} {s}
            </span>
          ))}
        </p>
      )}
      {nodes.length === 0 && (
        <p className="swarm-empty">
          No nodes yet. Start the runtime on a GPU machine with <code>remi up</code> and it shows up here.
        </p>
      )}
      {nodes.map(n => (
        <NodeBlock key={n.id.toString()} node={n} agents={agents.filter(a => a.node_id === n.id)} training={training.get(n.id)} ctx={ctx} />
      ))}
      {unplaced.length > 0 && (
        <section className="node" aria-label="Not placed">
          <h3 className="node-head">
            <span className="node-name">Not placed</span>
            <span className="node-gpu">no live node</span>
          </h3>
          <Rows agents={unplaced} ctx={ctx} />
        </section>
      )}
    </section>
  );
}

function Rows({ agents, ctx, loras }: { agents: SwarmAgent[]; ctx: RowCtx; loras?: string[] }) {
  return (
    <ul className="remi-list">
      {agents.map(a => {
        const id = a.id.toString();
        const activity = ctx.activity.get(id);
        const model = ctx.models.get(id);
        return (
          <RemiRow
            key={id}
            agent={a}
            open={ctx.openId === id}
            onToggle={() => ctx.toggle(id)}
            activity={activity}
            channelName={ctx.channels.find(c => c.id === activity?.channel_id)?.name}
            now={ctx.now}
            onOpenChannel={ctx.onOpenChannel}
            waiting={!!model && !!loras && !loras.includes(model)}
          />
        );
      })}
    </ul>
  );
}

const gb = (mb: number) => (mb / 1024).toFixed(1);

function Memory({ stats }: { stats?: NodeStats }) {
  if (!stats) {
    return (
      <div className="node-row">
        <span className="node-label">Memory</span>
        <span className="node-none">no stats yet</span>
      </div>
    );
  }
  const total = stats.vram_total_mb;
  const other = Math.max(0, stats.vram_used_mb - stats.vram_vllm_mb);
  const free = Math.max(0, total - stats.vram_used_mb);
  const pct = (mb: number) => `${Math.min(100, (mb / total) * 100)}%`;
  return (
    <div className="node-row">
      <span className="node-label">Memory</span>
      <span className="mem">
        <span
          className="mem-bar"
          role="img"
          aria-label={`vLLM ${gb(stats.vram_vllm_mb)} GB, other ${gb(other)} GB, free ${gb(free)} GB`}
          title={`vLLM (weights + context) ${gb(stats.vram_vllm_mb)} GB · other ${gb(other)} GB · free ${gb(free)} GB`}
        >
          <span className="mem-vllm" style={{ width: pct(stats.vram_vllm_mb) }} />
          <span className="mem-other" style={{ width: pct(other) }} />
        </span>
        <span className="mem-num">
          {gb(stats.vram_used_mb)} / {gb(total)} GB
        </span>
      </span>
    </div>
  );
}

function Slots({ stats, agents, ctx }: { stats: NodeStats; agents: SwarmAgent[]; ctx: RowCtx }) {
  const cells = Array.from({ length: Math.max(stats.lora_slots, stats.loras.length) }, (_, i) => stats.loras[i]);
  return (
    <div className="node-row node-row-top">
      <span className="node-label">
        LoRA slots <span className="node-count">{stats.loras.length}/{stats.lora_slots}</span>
      </span>
      <ul className="slots">
        {cells.map((lora, i) => {
          if (!lora) {
            return (
              <li key={`empty-${i}`} className="slot is-empty">
                <span className="sr-only">empty slot</span>
              </li>
            );
          }
          const users = agents.filter(a => ctx.models.get(a.id.toString()) === lora);
          const label = slotLabel(lora, users);
          const who = users.length ? users.map(a => a.name).join(', ') : 'no REMi here';
          return (
            <li key={lora} className="slot" title={`${label.full}\n${who}`}>
              <span className="slot-name">{label.short}</span>
              <span className="slot-users">
                {users.length} {users.length === 1 ? 'REMi' : 'REMis'}
              </span>
              <span className="sr-only">: {who}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function NodeBlock({ node, agents, training, ctx }: { node: SwarmNode; agents: SwarmAgent[]; training?: Training; ctx: RowCtx }) {
  const stats = parseStats(node.stats);
  return (
    <section className={`node is-${node.status}`} aria-label={`${node.name}, ${node.status}`}>
      <h3 className="node-head">
        <span className="node-name">{node.name}</span>
        <span className="node-gpu">{node.gpu}</span>
        <span className={`node-status node-${node.status}`}>
          <i aria-hidden="true" className="swarm-dot" />
          {node.status}
        </span>
      </h3>
      <Memory stats={stats} />
      {stats && <Slots stats={stats} agents={agents} ctx={ctx} />}
      {training && (
        <p className="node-training">
          Training {training.spec}
          {training.step !== undefined && <> · step {training.step}</>}
        </p>
      )}
      {agents.length > 0 ? <Rows agents={agents} ctx={ctx} loras={stats?.loras} /> : <p className="node-none">No REMis on this node.</p>}
    </section>
  );
}
