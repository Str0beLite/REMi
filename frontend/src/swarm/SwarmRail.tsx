import { RackUnit } from './RackUnit';
import { MIN_UNITS, UNIT_HEIGHT, trainingByNode, type SwarmAgent, type SwarmMessage, type SwarmNode } from './swarmData';
import './swarm.css';

type Props = { nodes: SwarmNode[]; agents: SwarmAgent[]; messages?: SwarmMessage[] };

// The Rack elevation signature: each node drawn as a U-numbered rack, each REMi a 2U plate.
export function SwarmRail({ nodes, agents, messages = [] }: Props) {
  const training = trainingByNode(messages, agents, nodes);
  return (
    <section className="swarm" aria-labelledby="swarm-title">
      <header className="swarm-head">
        <h2 id="swarm-title">Swarm</h2>
        <span className="swarm-count">
          {agents.length} {agents.length === 1 ? 'REMi' : 'REMis'} · {nodes.length} {nodes.length === 1 ? 'node' : 'nodes'}
        </span>
      </header>
      {nodes.length === 0 ? (
        <p className="swarm-empty">
          No nodes yet. Start the runtime on a GPU machine with <code>remi up</code> and it registers here as a rack.
        </p>
      ) : (
        nodes.map(n => <Rack key={n.id.toString()} node={n} agents={agents.filter(a => a.node_id === n.id)} training={training.get(n.id)} />)
      )}
    </section>
  );
}

function Rack({ node, agents, training }: { node: SwarmNode; agents: SwarmAgent[]; training?: { spec: string; step?: number } }) {
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
          <RackUnit key={a.id.toString()} agent={a} row={i * UNIT_HEIGHT + 1} />
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
