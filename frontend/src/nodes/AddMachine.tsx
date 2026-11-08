import { useEffect, useRef, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import { STDB_DB, STDB_URI } from '../stdb';
import { newAdminCode } from '../admin/claim';
import { addMachineFocus, clusterConsoleUrl, joinLink } from './joinCommand';
import './nodes.css';

// The code lives in a private table, so the console can't read it back. This browser remembers the one it made.
// shortcut: another admin's browser only learns that joining is on; it shows a link after New code.
const CODE_KEY = `${STDB_URI}/${STDB_DB}/node_join_code`;
const loadCode = () => {
  try {
    return localStorage.getItem(CODE_KEY) ?? '';
  } catch {
    return '';
  }
};
const saveCode = (code: string) => {
  try {
    if (code) localStorage.setItem(CODE_KEY, code);
    else localStorage.removeItem(CODE_KEY);
  } catch {
    // private mode: the code shows until this tab closes
  }
};

// Admins: hand a new machine a join link (#83). Joined machines appear in the Nodes list below.
export function AddMachine() {
  const { identity } = useSpacetimeDB();
  const [users] = useTable(tables.user);
  const [settings] = useTable(tables.setting);
  const setJoinCode = useReducer(reducers.setNodeJoinCode);
  const [code, setCode] = useState(loadCode);
  const [state, setState] = useState('');
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const isAdmin = users.find(u => identity && u.identity.isEqual(identity))?.isAdmin === true;

  useEffect(() => {
    if (!addMachineFocus.pending || !heading.current) return;
    addMachineFocus.pending = false;
    heading.current.scrollIntoView({ block: 'start' });
    heading.current.focus();
  }, [isAdmin]);

  if (!isAdmin) return null;

  const setting = (k: string) => settings.find(s => s.key === k)?.value ?? '';
  const joining = setting('node_joining') === 'on';
  const url = clusterConsoleUrl(setting('workspace_url'), location);
  const known = joining ? code : '';
  const command = known && url ? joinLink(url, STDB_DB, known) : '';

  async function apply(next: string, done: string) {
    setError('');
    setState('');
    try {
      await setJoinCode({ code: next });
      saveCode(next);
      setCode(next);
      setState(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setState('Copied');
    } catch {
      setState('Select the link and copy it');
    }
  }

  return (
    <section className="add-machine" aria-labelledby="add-machine-title">
      <h2 id="add-machine-title" ref={heading} tabIndex={-1}>
        Add a machine
      </h2>
      <p className="setting-hint">
        On the new PC (with an NVIDIA GPU), run <code>scripts/remi up</code>, open the link it prints, choose Join an existing
        cluster and paste the join link below. It shows up under Nodes, ready to take REMis. A join link adds machines only;
        it never makes anyone an admin.
      </p>

      {!url && (
        <p className="add-machine-note">
          This console is open on localhost and REMi doesn't know the address other machines reach this PC by. Open the
          console at that address instead, or set <code>REMI_WORKSPACE_HOST</code> in <code>.env</code> and run{' '}
          <code>scripts/remi up</code> again.
        </p>
      )}

      {!joining ? (
        <div className="add-machine-actions">
          <button type="button" className="btn-primary" onClick={() => apply(newAdminCode(), 'Joining is on')}>
            Allow machines to join
          </button>
        </div>
      ) : (
        <>
          {command ? (
            <div className="join-cmd">
              <pre aria-label="Join link to paste on the new machine">
                <code>{command}</code>
              </pre>
              <button type="button" onClick={copy}>
                Copy
              </button>
            </div>
          ) : (
            !known && (
              <p className="setting-hint">
                Joining is on, with a link made in another browser. New link shows a fresh one; the old link stops working.
              </p>
            )
          )}
          <div className="add-machine-actions">
            <button type="button" onClick={() => apply(newAdminCode(), 'New link: the old one no longer works')}>
              New link
            </button>
            <button type="button" onClick={() => apply('', 'Joining is off')}>
              Turn off joining
            </button>
          </div>
          <p className="setting-hint">Machines that already joined keep working after a new link or turning joining off.</p>
        </>
      )}
      <p className="setting-state" role="status">
        {state}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
