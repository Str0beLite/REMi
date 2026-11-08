import type { ReactNode } from 'react';
import { RemiAvatar } from '../components/RemiAvatar';
import { defaultLook } from '../components/remiLook';
import { ago, type Activity, type SwarmAgent } from './swarmData';

type Props = {
  agent: SwarmAgent;
  row?: number; // grid row in a rack; omitted for the unplaced list
  activity?: Activity;
  channelName?: string;
  now: number;
  onOpen?: (channelId: bigint) => void;
};

// One REMi as a 2U unit plate: headgear face, name, what it did last, status as text.
// Clicking the plate jumps to the channel it last spoke in.
export function RackUnit({ agent, row, activity, channelName, now, onOpen }: Props) {
  const look = agent.headgear ? { headgear: agent.headgear, tint: agent.tint ?? defaultLook(agent).tint } : defaultLook(agent);
  const stopped = agent.status === 'stopped';
  const target = activity?.channel_id;
  const cls = `rack-plate${stopped ? ' is-stopped' : ''}${activity?.needsHelp ? ' needs-help' : ''}`;
  const doing = activity ? (
    <span className="rack-plate-now">
      {activity.label}
      {channelName && <> in {channelName}</>}
      {activity.ts !== undefined && <> · {ago(activity.ts, now)}</>}
    </span>
  ) : null;
  const body: ReactNode = (
    <>
      <RemiAvatar status={agent.status} headgear={look.headgear} tint={look.tint} size={30} />
      <span className="rack-plate-text">
        <b>{agent.name}</b>
        <span className="rack-plate-purpose">{agent.purpose}</span>
        {doing}
      </span>
      <span className={`rack-plate-status status-${agent.status}`}>{agent.status}</span>
    </>
  );
  return (
    <li className={cls} style={row ? { gridRow: `${row} / span 2` } : undefined}>
      {onOpen && target !== undefined ? (
        <button
          type="button"
          className="rack-plate-hit"
          onClick={() => onOpen(target)}
          title={channelName ? `Open ${channelName}` : 'Open its channel'}
        >
          {body}
        </button>
      ) : (
        body
      )}
    </li>
  );
}
