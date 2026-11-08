import { RemiAvatar } from '../components/RemiAvatar';
import { defaultLook } from '../components/remiLook';
import type { SwarmAgent } from './swarmData';

// One REMi as a 2U unit plate: headgear face, name, one-line purpose, status as text.
export function RackUnit({ agent, row }: { agent: SwarmAgent; row: number }) {
  const look = agent.headgear ? { headgear: agent.headgear, tint: agent.tint ?? defaultLook(agent).tint } : defaultLook(agent);
  const stopped = agent.status === 'stopped';
  return (
    <li className={`rack-plate${stopped ? ' is-stopped' : ''}`} style={{ gridRow: `${row} / span 2` }}>
      <RemiAvatar status={agent.status} headgear={look.headgear} tint={look.tint} size={30} />
      <span className="rack-plate-text">
        <b>{agent.name}</b>
        <span className="rack-plate-purpose">{agent.purpose}</span>
      </span>
      <span className={`rack-plate-status status-${agent.status}`}>{agent.status}</span>
    </li>
  );
}
