import { useState, type FormEvent, type ReactNode } from 'react';

import { channelSlug } from './channelSlug';

export type RailChannel = { id: bigint; name: string; unread?: number; threads?: RailChannel[] };
export type RailDm = { id: bigint; name: string; avatar?: ReactNode; unread?: number };

type Props = {
  workspace: string;
  nav?: ReactNode; // links above Channels (the console's panels)
  channels: RailChannel[];
  dms: RailDm[];
  activeId?: bigint;
  onSelect: (id: bigint) => void;
  onCreate?: (name: string) => Promise<void>;
  onCreateThread?: (parentId: bigint, name: string) => Promise<void>;
  user: { nickname: string; isAdmin: boolean };
  onOpenSettings?: () => void; // the user row opens settings (Config), as in most chat apps
  settingsCurrent?: boolean;
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map(p => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

// what the open name form creates: a channel (parent undefined) or a thread under `parent`
type Draft = { parent?: bigint; name: string };

// Plum channel rail: workspace, public channels with their threads as a tree, DMs, current user.
export function ChannelRail({ workspace, nav, channels, dms, activeId, onSelect, onCreate, onCreateThread, user, onOpenSettings, settingsCurrent }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isThread = draft?.parent !== undefined;
  const value = draft ? (isThread ? draft.name.trim() : channelSlug(draft.name)) : '';

  function openForm(parent?: bigint) {
    setDraft({ parent, name: '' });
    setError('');
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!draft || !value) return;
    if (!isThread && channels.some(c => c.name === value)) return setError(`# ${value} already exists`);
    setBusy(true);
    setError('');
    try {
      if (isThread) await onCreateThread?.(draft.parent!, value);
      else await onCreate?.(value);
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const form = draft && (
    <form className="rail-new" onSubmit={create}>
      <label className="sr-only" htmlFor="rail-new-name">
        {isThread ? 'New thread name' : 'New channel name'}
      </label>
      <input
        id="rail-new-name"
        name="rail-new-name"
        autoComplete="off"
        spellCheck={isThread}
        autoFocus
        maxLength={isThread ? 80 : 40}
        placeholder={isThread ? 'Thread topic…' : 'new-channel'}
        value={draft.name}
        onChange={e => {
          setDraft({ ...draft, name: e.target.value });
          setError('');
        }}
        onKeyDown={e => e.key === 'Escape' && setDraft(null)}
      />
      <button type="submit" disabled={busy || !value}>
        Create
      </button>
      <button type="button" onClick={() => setDraft(null)}>
        Cancel
      </button>
      {!isThread && draft.name && value !== draft.name && !error && <small>Will be # {value || '…'}</small>}
      {error && (
        <small role="alert" className="rail-new-error">
          {error}
        </small>
      )}
    </form>
  );

  const button = (id: bigint, label: ReactNode, unread = 0, lead?: ReactNode) => (
    <button type="button" className="rail-item" aria-current={id === activeId ? 'page' : undefined} onClick={() => onSelect(id)}>
      {lead}
      <span className="rail-label">{label}</span>
      {unread > 0 && (
        <span className="rail-badge" aria-label={`${unread} unread`}>
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );

  const channel = (c: RailChannel) => (
    <li key={c.id.toString()}>
      <div className="rail-row">
        {button(c.id, `# ${c.name}`, c.unread)}
        {onCreateThread && (
          <button type="button" className="rail-add rail-row-add" aria-label={`New thread in # ${c.name}`} title="New thread" onClick={() => openForm(c.id)}>
            +
          </button>
        )}
      </div>
      {(c.threads?.length || draft?.parent === c.id) && (
        <ul className="rail-list rail-threads">
          {c.threads?.map(t => <li key={t.id.toString()}>{button(t.id, t.name, t.unread)}</li>)}
          {draft?.parent === c.id && <li>{form}</li>}
        </ul>
      )}
    </li>
  );

  const me = (
    <>
      <span className="rail-initials rail-initials-me" aria-hidden="true">
        {initials(user.nickname)}
      </span>
      <span className="rail-me-name">
        <b>{user.nickname}</b>
        {user.isAdmin && <small>Admin</small>}
      </span>
    </>
  );

  return (
    <div className="rail">
      <div className="rail-ws">{workspace}</div>
      {nav}
      <div className="rail-heading-row">
        <h2 className="rail-heading">Channels</h2>
        {onCreate && (
          <button type="button" className="rail-add" aria-label="New channel" title="New channel" onClick={() => openForm()}>
            +
          </button>
        )}
      </div>
      <ul className="rail-list">{channels.map(channel)}</ul>
      {draft && !isThread && form}
      {dms.length > 0 && (
        <>
          <h2 className="rail-heading">Direct messages</h2>
          <ul className="rail-list">
            {dms.map(d => (
              <li key={d.id.toString()}>{button(d.id, d.name, d.unread, d.avatar ?? <span className="rail-initials">{initials(d.name)}</span>)}</li>
            ))}
          </ul>
        </>
      )}
      {onOpenSettings ? (
        <button type="button" className="rail-me" aria-current={settingsCurrent ? 'page' : undefined} onClick={onOpenSettings} title="Settings">
          {me}
          <svg className="rail-me-gear" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
              transform="translate(-1 0)"
            />
          </svg>
          <span className="sr-only">Settings</span>
        </button>
      ) : (
        <div className="rail-me">{me}</div>
      )}
    </div>
  );
}
