import { useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import { adminLinkFor, newAdminCode } from '../admin/claim';
import type { User } from '../module_bindings/types';
import { personActions } from './configData';

// Who is in the workspace, and (admins) a one-time link that makes whoever opens it an admin, plus per-person
// Make admin / Remove admin / Remove (#95).
export function People() {
  const { identity } = useSpacetimeDB();
  const [users] = useTable(tables.user);
  const [channels] = useTable(tables.channel);
  const addAdminCode = useReducer(reducers.addAdminCode);
  const removeUser = useReducer(reducers.removeUser);
  const setUserAdmin = useReducer(reducers.setUserAdmin);
  const [link, setLink] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'error'>('idle');
  const [error, setError] = useState('');
  const [busyHex, setBusyHex] = useState('');
  const [rowError, setRowError] = useState('');
  const isAdmin = users.find(u => identity && u.identity.isEqual(identity))?.isAdmin === true;
  const sorted = [...users].sort((a, b) => Number(b.isAdmin) - Number(a.isAdmin) || a.nickname.localeCompare(b.nickname));
  const me = identity?.toHexString() ?? '';
  // The publisher: init creates #general as them, so this survives a nickname change (same rule as the module).
  const owner = channels.find(c => c.name === 'general' && c.kind === 'public' && c.parentId === 0n)?.createdBy.toHexString() ?? '';

  async function act(u: User, question: string, call: () => Promise<unknown>) {
    if (!window.confirm(question)) return;
    setBusyHex(u.identity.toHexString());
    setRowError('');
    try {
      await call();
    } catch (err) {
      setRowError(`${u.nickname}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyHex('');
    }
  }

  async function create() {
    setState('busy');
    setError('');
    const code = newAdminCode();
    try {
      await addAdminCode({ code });
      setLink(adminLinkFor(code));
      setState('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setState('copied');
    } catch {
      setError('Copy failed: select the link and copy it by hand.');
      setState('error');
    }
  }

  return (
    <section>
      <h2>People</h2>
      <ul className="people">
        {sorted.map(u => {
          const hex = u.identity.toHexString();
          const can = personActions(hex, u.isAdmin, me, owner, isAdmin);
          const busy = busyHex !== '';
          return (
            <li key={hex}>
              <span className="people-name">{u.nickname}</span>
              {hex === me ? (
                <span className="people-you">you</span>
              ) : (
                hex === owner && <span className="people-you">set up this workspace with remi up</span>
              )}
              {u.isAdmin && <span className="people-admin">admin</span>}
              {(can.makeAdmin || can.removeAdmin || can.remove) && (
                <span className="people-actions">
                  {can.makeAdmin && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Make ${u.nickname} an admin`}
                      onClick={() =>
                        act(u, `Make ${u.nickname} an admin?\n\nAdmins can change settings, review tools and agents, and manage people.`, () =>
                          setUserAdmin({ identity: u.identity, isAdmin: true }),
                        )
                      }
                    >
                      Make admin
                    </button>
                  )}
                  {can.removeAdmin && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Remove admin from ${u.nickname}`}
                      onClick={() =>
                        act(u, `Remove admin from ${u.nickname}?\n\nThey stay in the workspace as a regular member.`, () =>
                          setUserAdmin({ identity: u.identity, isAdmin: false }),
                        )
                      }
                    >
                      Remove admin
                    </button>
                  )}
                  {can.remove && (
                    <button
                      type="button"
                      className="people-remove"
                      disabled={busy}
                      aria-label={`Remove ${u.nickname} from the workspace`}
                      onClick={() =>
                        act(
                          u,
                          `Remove ${u.nickname} from the workspace?\n\nTheir messages stay, shown as "former member". Agents they own stay, and admins can still manage them. If they open the console again, they join as someone new.`,
                          () => removeUser({ identity: u.identity }),
                        )
                      }
                    >
                      {busyHex === hex ? 'Working…' : 'Remove'}
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {rowError && (
        <p className="form-error" role="alert">
          {rowError}
        </p>
      )}
      {isAdmin && (
        <div className="setting admin-link">
          <span className="admin-link-label">Make someone an admin</span>
          <p className="setting-hint">Creates a link that works once. Whoever opens it and joins becomes an admin; send it only to that person.</p>
          {link ? (
            <div className="setting-row">
              <input aria-label="Admin link" readOnly value={link} onFocus={e => e.currentTarget.select()} className="mono" />
              <button type="button" className="btn-primary" onClick={copy}>
                {state === 'copied' ? 'Copied' : 'Copy link'}
              </button>
              <button type="button" onClick={create} disabled={state === 'busy'}>
                New link
              </button>
            </div>
          ) : (
            <div className="setting-row">
              <button type="button" onClick={create} disabled={state === 'busy'}>
                {state === 'busy' ? 'Creating…' : 'Create admin link'}
              </button>
            </div>
          )}
          {state === 'error' && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
