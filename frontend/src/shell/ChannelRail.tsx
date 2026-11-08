import type { ReactNode } from 'react';

export type RailChannel = { id: bigint; name: string; unread?: number };
export type RailDm = { id: bigint; name: string; avatar?: ReactNode; unread?: number };

type Props = {
  workspace: string;
  channels: RailChannel[];
  dms: RailDm[];
  activeId?: bigint;
  onSelect: (id: bigint) => void;
  user: { nickname: string; isAdmin: boolean };
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map(p => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

// Plum channel rail: workspace, public channels with unread counts, DMs, current user.
export function ChannelRail({ workspace, channels, dms, activeId, onSelect, user }: Props) {
  const item = (id: bigint, label: ReactNode, unread = 0, lead?: ReactNode) => (
    <li key={id.toString()}>
      <button
        type="button"
        className="rail-item"
        aria-current={id === activeId ? 'page' : undefined}
        onClick={() => onSelect(id)}
      >
        {lead}
        <span className="rail-label">{label}</span>
        {unread > 0 && (
          <span className="rail-badge" aria-label={`${unread} unread`}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    </li>
  );

  return (
    <div className="rail">
      <div className="rail-ws">{workspace}</div>
      <h2 className="rail-heading">Channels</h2>
      <ul className="rail-list">{channels.map(c => item(c.id, `# ${c.name}`, c.unread))}</ul>
      {dms.length > 0 && (
        <>
          <h2 className="rail-heading">Direct messages</h2>
          <ul className="rail-list">{dms.map(d => item(d.id, d.name, d.unread, d.avatar ?? <span className="rail-initials">{initials(d.name)}</span>))}</ul>
        </>
      )}
      <div className="rail-me">
        <span className="rail-initials rail-initials-me" aria-hidden="true">
          {initials(user.nickname)}
        </span>
        <span>
          <b>{user.nickname}</b>
          {user.isAdmin && <small>Admin</small>}
        </span>
      </div>
    </div>
  );
}
