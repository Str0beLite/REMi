import { AGENT_STATUSES } from '../components/remiLook';
import { RackUnit } from './RackUnit';
import {
  MIN_UNITS,
  UNIT_HEIGHT,
  activityByAgent,
  trainingByNode,
  type Activity,
  type SwarmAgent,
  type SwarmMessage,
  type SwarmNode,
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

type PlateCtx = { activity: Map<string, Activity>; channels: Channel[]; now: number; onOpen?: (id: bigint) => void };

// The Rack elevation signature: each node drawn as a U-numbered rack, each REMi a 2U plate.
// Every REMi is on screen: ones whose node isn't registered (or is gone) are listed under "Not placed".
export function SwarmRail({ nodes, agents, messages = [], channels = [], onOpenChannel, now = Date.now() }: Props) {
  const training = trainingByNode(messages, agents, nodes);
  const ctx: PlateCtx = { activity: activityByAgent(messages), channels, now, onOpen: onOpenChannel };
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
          No nodes yet. Start the runtime on a GPU machine with <code>remi up</code> and it registers here as a rack.
        </p>
      )}
      {nodes.map(n => (
        <Rack key={n.id.toString()} node={n} agents={agents.filter(a => a.node_id === n.id)} training={training.get(n.id)} ctx={ctx} />
      ))}
      {unplaced.length > 0 && (
        <div className="rack-node">
          <h3 className="rack-title">
            Not placed
            <span className="rack-meta">no live node</span>
          </h3>
          <ul className="rack-list">
            {unplaced.map(a => (
              <Plate key={a.id.toString()} agent={a} ctx={ctx} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Plate({ agent, row, ctx }: { agent: SwarmAgent; row?: number; ctx: PlateCtx }) {
  const activity = ctx.activity.get(agent.id.toString());
  const channelName = ctx.channels.find(c => c.id === activity?.channel_id)?.name;
  return <RackUnit agent={agent} row={row} activity={activity} channelName={channelName} now={ctx.now} onOpen={ctx.onOpen} />;
}

function Rack({ node, agents, training, ctx }: { node: SwarmNode; agents: SwarmAgent[]; training?: { spec: string; step?: number }; ctx: PlateCtx }) {
  const used = agents.length * UNIT_HEIGHT;
  const units = Math.max(MIN_UNITS, used);
  const free = units - used;
  return (
    <div className="rack-node">
      <h3 className="rack-title">
        <span className="mono">{node.name}</span>
        <span className="rack-meta">
          {node.gpu} · <span className={`node-status node-${node.status}`}>{node.status}</span>
        </span>
      </h3>
      <ol className="rack" style={{ gridTemplateRows: `repeat(${units}, var(--rack-u))` }} aria-label={`${node.name}: ${used} of ${units}U used`}>
        {Array.from({ length: units }, (_, i) => (
          <li key={`u${i}`} className="rack-u" aria-hidden="true" style={{ gridRow: i + 1 }}>
            U{units - i}
          </li>
        ))}
        {agents.map((a, i) => (
          <Plate key={a.id.toString()} agent={a} row={i * UNIT_HEIGHT + 1} ctx={ctx} />
        ))}
        {free > 0 && (
          <li className={training ? 'rack-band' : 'rack-free'} style={{ gridRow: `${used + 1} / span ${free}` }}>
            {training ? (
              <span>
                Training <span className="mono">{training.spec}</span>
                {training.step !== undefined && <> · step {training.step}</>}
              </span>
            ) : (
              <span className="mono">{free}U free</span>
            )}
          </li>
        )}
      </ol>
    </div>
  );
}
