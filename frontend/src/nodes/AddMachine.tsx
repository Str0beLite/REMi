import { useEffect, useRef, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import { STDB_DB, STDB_URI } from '../stdb';
import { addMachineFocus, joinCommand, newJoinCode, workspaceUrl } from './joinCommand';
import './nodes.css';

// The code lives in a private table, so the console can't read it back. This browser remembers the one it made.
// shortcut: another admin's browser only learns that joining is on; it shows a command after New code.
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

// Admins: let another PC join this workspace with one command (#83). Joined machines appear in the Nodes list below.
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
  const url = workspaceUrl(setting('workspace_url'), STDB_URI);
  const known = joining ? code : '';
  const command = known && url ? joinCommand(url, STDB_DB, known) : '';

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
      setState('Select the command and copy it');
    }
  }

  return (
    <section className="add-machine" aria-labelledby="add-machine-title">
      <h2 id="add-machine-title" ref={heading} tabIndex={-1}>
        Add a machine
      </h2>
      <p className="setting-hint">
        Run one command on another PC with an NVIDIA GPU. It installs what's missing, starts a node and shows up under Nodes,
        ready to take REMis. A join code adds machines only; it never makes anyone an admin.
      </p>

      {!url && (
        <p className="add-machine-note">
          Other machines can't reach this workspace yet: it only listens on this PC. Run <code>scripts/remi up --lan</code>{' '}
          here to open it to your network, then come back, or open this console at an address the other machines use.
        </p>
      )}

      {!joining ? (
        <div className="add-machine-actions">
          <button type="button" className="btn-primary" onClick={() => apply(newJoinCode(), 'Joining is on')}>
            Allow machines to join
          </button>
        </div>
      ) : (
        <>
          {command ? (
            <div className="join-cmd">
              <pre aria-label="Command to run on the new machine">
                <code>{command}</code>
              </pre>
              <button type="button" onClick={copy}>
                Copy
              </button>
            </div>
          ) : (
            !known && (
              <p className="setting-hint">
                Joining is on, with a code made in another browser. New code shows a fresh one; the old code stops working.
              </p>
            )
          )}
          <div className="add-machine-actions">
            <button type="button" onClick={() => apply(newJoinCode(), 'New code: the old one no longer works')}>
              New code
            </button>
            <button type="button" onClick={() => apply('', 'Joining is off')}>
              Turn off joining
            </button>
          </div>
          <p className="setting-hint">Machines that already joined keep working after a new code or turning joining off.</p>
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
