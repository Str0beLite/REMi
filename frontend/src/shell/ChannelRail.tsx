import { useState, type FormEvent, type ReactNode } from 'react';

import { channelSlug } from './channelSlug';

export type RailChannel = { id: bigint; name: string; unread?: number };
export type RailDm = { id: bigint; name: string; avatar?: ReactNode; unread?: number };

type Props = {
  workspace: string;
  channels: RailChannel[];
  dms: RailDm[];
  activeId?: bigint;
  onSelect: (id: bigint) => void;
  onCreate?: (name: string) => Promise<void>;
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
export function ChannelRail({ workspace, channels, dms, activeId, onSelect, onCreate, user }: Props) {
  const [name, setName] = useState<string | null>(null); // null = form closed
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    const slug = channelSlug(name ?? '');
    if (!slug || !onCreate) return;
    if (channels.some(c => c.name === slug)) return setError(`# ${slug} already exists`);
    setBusy(true);
    setError('');
    try {
      await onCreate(slug);
      setName(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

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
      <div className="rail-heading-row">
        <h2 className="rail-heading">Channels</h2>
        {onCreate && name === null && (
          <button type="button" className="rail-add" aria-label="New channel" title="New channel" onClick={() => setName('')}>
            +
          </button>
        )}
      </div>
      <ul className="rail-list">{channels.map(c => item(c.id, `# ${c.name}`, c.unread))}</ul>
      {onCreate && name !== null && (
        <form className="rail-new" onSubmit={create}>
          <label className="sr-only" htmlFor="new-channel">
            New channel name
          </label>
          <input
            id="new-channel"
            name="new-channel"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            maxLength={40}
            placeholder="new-channel"
            value={name}
            onChange={e => {
              setName(e.target.value);
              setError('');
            }}
            onKeyDown={e => e.key === 'Escape' && setName(null)}
          />
          <button type="submit" disabled={busy || !channelSlug(name)}>
            Create
          </button>
          <button type="button" onClick={() => setName(null)}>
            Cancel
          </button>
          {name && channelSlug(name) !== name && !error && <small>Will be # {channelSlug(name) || '…'}</small>}
          {error && (
            <small role="alert" className="rail-new-error">
              {error}
            </small>
          )}
        </form>
      )}
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
