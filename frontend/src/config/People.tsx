import { useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import { adminLinkFor, newAdminCode } from '../admin/claim';

// Who is in the workspace, and (admins) a one-time link that makes whoever opens it an admin.
export function People() {
  const { identity } = useSpacetimeDB();
  const [users] = useTable(tables.user);
  const addAdminCode = useReducer(reducers.addAdminCode);
  const [link, setLink] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'error'>('idle');
  const [error, setError] = useState('');
  const isAdmin = users.find(u => identity && u.identity.isEqual(identity))?.isAdmin === true;
  const sorted = [...users].sort((a, b) => Number(b.isAdmin) - Number(a.isAdmin) || a.nickname.localeCompare(b.nickname));

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
        {sorted.map(u => (
          <li key={u.identity.toHexString()}>
            <span className="people-name">{u.nickname}</span>
            {identity && u.identity.isEqual(identity) ? (
              <span className="people-you">you</span>
            ) : (
              u.nickname === 'owner' && <span className="people-you">set up this workspace with remi up</span>
            )}
            {u.isAdmin && <span className="people-admin">admin</span>}
          </li>
        ))}
      </ul>
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
