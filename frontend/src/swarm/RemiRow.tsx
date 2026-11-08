import { useId } from 'react';
import { RemiAvatar } from '../components/RemiAvatar';
import { defaultLook } from '../components/remiLook';
import { ago, skillLabel, type Activity, type SwarmAgent } from './swarmData';

type Props = {
  agent: SwarmAgent;
  open: boolean;
  onToggle: () => void;
  activity?: Activity;
  channelName?: string;
  now: number;
  onOpenChannel?: (channelId: bigint) => void;
  waiting?: boolean; // its LoRA isn't in one of the node's slots right now
};

function Chevron() {
  return (
    <svg className="remi-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// One REMi: face, name, status; its skills underneath. Opens in place to show what it did last, its tools and adapters.
export function RemiRow({ agent, open, onToggle, activity, channelName, now, onOpenChannel, waiting }: Props) {
  const uid = useId();
  const look = agent.headgear ? { headgear: agent.headgear, tint: agent.tint ?? defaultLook(agent).tint } : defaultLook(agent);
  const ads = (agent.adapters ?? []).filter(a => a.weight > 0);
  const tools = agent.tools ?? [];
  const cls = `remi-row${open ? ' is-open' : ''}${agent.status === 'stopped' ? ' is-stopped' : ''}${activity?.needsHelp ? ' needs-help' : ''}`;
  const target = activity?.channel_id;

  return (
    <li className={cls}>
      <button type="button" className="remi-head" aria-expanded={open} aria-controls={`${uid}-detail`} onClick={onToggle}>
        <RemiAvatar status={agent.status} headgear={look.headgear} tint={look.tint} size={28} />
        <span className="remi-main">
          <span className="remi-name-line">
            <b className="remi-name" title={agent.name}>
              {agent.name}
            </b>
            {activity?.needsHelp && <span className="remi-flag">needs help</span>}
          </span>
          <span className="remi-skill" title={skillLabel(agent.adapters)}>
            {skillLabel(agent.adapters)}
            {waiting && <span className="remi-waiting"> · waiting for a slot</span>}
          </span>
        </span>
        <span className={`remi-status status-${agent.status}`}>{agent.status}</span>
        <Chevron />
      </button>
      {open && (
        <div id={`${uid}-detail`} className="remi-detail">
          {agent.purpose && <p className="remi-purpose">{agent.purpose}</p>}
          <p className="remi-last">
            {activity ? (
              <>
                {activity.label}
                {channelName && <> in {channelName}</>}
                {activity.ts !== undefined && <> · {ago(activity.ts, now)}</>}
              </>
            ) : (
              'Nothing yet.'
            )}
            {onOpenChannel && target !== undefined && (
              <button type="button" className="remi-link" onClick={() => onOpenChannel(target)}>
                Open {channelName ?? 'channel'}
              </button>
            )}
          </p>
          <dl className="remi-kit">
            <dt>Adapters</dt>
            <dd>
              {ads.length
                ? ads.map(a => (
                    <span key={`${a.name}@${a.version}`} className="remi-chip">
                      {a.name} v{a.version}
                      {a.weight !== 1 && <span className="remi-chip-dim"> {Math.round(a.weight * 100)}%</span>}
                    </span>
                  ))
                : 'none, runs on the base model'}
            </dd>
            <dt>Tools</dt>
            <dd>
              {tools.length
                ? tools.map(t => (
                    <code key={t} className="remi-chip">
                      /{t}
                    </code>
                  ))
                : 'none'}
            </dd>
          </dl>
        </div>
      )}
    </li>
  );
}
