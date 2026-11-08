import { useEffect, useState, type FormEvent } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import { agoLabel, cronError, cronLabel, minutesError, nodeHealth } from './configData';
import { McpServers } from './McpServers';
import { AddMachine } from '../nodes/AddMachine';
import { People } from './People';
import './config.css';

const nowMicros = () => BigInt(Date.now()) * 1000n;

// One editable setting with its own validation, Save and saved/error feedback.
function SettingField({
  id,
  label,
  hint,
  value,
  validate,
  canEdit,
  inputMode,
  explain,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  validate: (v: string) => string;
  canEdit: boolean;
  inputMode?: 'numeric';
  explain?: (v: string) => string; // plain-words reading of the value, shown under the field
}) {
  const setSetting = useReducer(reducers.setSetting);
  const [draft, setDraft] = useState(value);
  const [touched, setTouched] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [serverError, setServerError] = useState('');
  const error = validate(draft);
  const dirty = draft.trim() !== value;

  // Follow the server value (it arrives after first render) until the user starts typing.
  useEffect(() => {
    if (!touched) setDraft(value);
  }, [value, touched]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (error || !dirty) return;
    setStatus('saving');
    setServerError('');
    try {
      await setSetting({ key: id, value: draft.trim() });
      setStatus('saved');
      setTouched(false);
    } catch (err) {
      setStatus('error');
      setServerError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form className="setting" onSubmit={save}>
      <label htmlFor={`setting-${id}`}>{label}</label>
      <p className="setting-hint" id={`setting-${id}-hint`}>
        {hint}
      </p>
      <div className="setting-row">
        <input
          id={`setting-${id}`}
          name={id}
          className="mono"
          value={draft}
          readOnly={!canEdit}
          inputMode={inputMode}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!error}
          aria-describedby={`setting-${id}-hint${error ? ` setting-${id}-err` : ''}`}
          onChange={e => {
            setDraft(e.target.value);
            setTouched(true);
            setStatus('idle');
          }}
        />
        {canEdit && (
          <button type="submit" disabled={!!error || !dirty || status === 'saving'}>
            {status === 'saving' ? 'Saving…' : 'Save'}
          </button>
        )}
        <span className="setting-state" role="status">
          {status === 'saved' && !dirty ? 'Saved' : ''}
        </span>
      </div>
      {!error && explain?.(draft) && <p className="setting-explain">= {explain(draft)}</p>}
      {error && (
        <p className="form-error" id={`setting-${id}-err`}>
          {error}
        </p>
      )}
      {serverError && (
        <p className="form-error" role="alert">
          {serverError}
        </p>
      )}
    </form>
  );
}

// Nodes, runtime settings and your nickname, so nobody has to touch a config file.
export function ConfigPanel() {
  const { identity } = useSpacetimeDB();
  const [nodes] = useTable(tables.node);
  const [settings] = useTable(tables.setting);
  const [users] = useTable(tables.user);
  const setNickname = useReducer(reducers.setNickname);
  const [now, setNow] = useState(nowMicros);
  const me = users.find(u => identity && u.identity.isEqual(identity));
  const isAdmin = me?.isAdmin === true;
  const [nick, setNick] = useState(me?.nickname ?? '');
  const [nickTouched, setNickTouched] = useState(false);
  const [nickState, setNickState] = useState('');
  const myNick = me?.nickname ?? '';
  useEffect(() => {
    if (!nickTouched) setNick(myNick);
  }, [myNick, nickTouched]);

  // "last seen" and the 30 s down rule need a clock, not just table updates.
  useEffect(() => {
    const t = window.setInterval(() => setNow(nowMicros()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const value = (k: string) => settings.find(s => s.key === k)?.value ?? '';
  const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name));

  async function saveNick(e: FormEvent) {
    e.preventDefault();
    setNickState('');
    try {
      await setNickname({ nickname: nick.trim() });
      setNickState('Saved');
      setNickTouched(false);
    } catch (err) {
      setNickState(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="config">
      <section>
        <h2>You</h2>
        <form className="setting" onSubmit={saveNick}>
          <label htmlFor="config-nickname">Nickname</label>
          <div className="setting-row">
            <input
              id="config-nickname"
              name="nickname"
              autoComplete="nickname"
              maxLength={24}
              value={nick}
              onChange={e => {
                setNick(e.target.value);
                setNickTouched(true);
                setNickState('');
              }}
            />
            <button type="submit" disabled={!nick.trim() || nick.trim() === me?.nickname}>
              Save
            </button>
            <span className="setting-state" role="status">
              {nickState}
            </span>
          </div>
          {isAdmin && <p className="setting-hint">You are an admin.</p>}
        </form>
      </section>

      <People />

      <McpServers />

      <AddMachine />

      <section>
        <h2>Nodes</h2>
        {sorted.length === 0 ? (
          <p className="setting-hint">No nodes yet. Run the runtime on a GPU machine and it registers here.</p>
        ) : (
          <div className="nodes-wrap">
            <table className="nodes">
              <thead>
                <tr>
                  <th scope="col">Node</th>
                  <th scope="col">GPU</th>
                  <th scope="col">Base model</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(n => {
                  const seen = n.lastSeen.microsSinceUnixEpoch;
                  const health = nodeHealth(n.status, seen, now);
                  return (
                    <tr key={String(n.id)}>
                      <td className="mono">{n.name}</td>
                      <td>{n.gpu}</td>
                      <td className="mono node-base">{n.baseModel}</td>
                      <td>
                        <span className={`node-health h-${health}`}>
                          <i aria-hidden="true" />
                          {health}
                          {health === 'down' && n.status !== 'down' && <small> (no heartbeat)</small>}
                        </span>
                      </td>
                      <td className="tabular">{agoLabel(seen, now)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2>Sleep</h2>
        {!isAdmin && <p className="setting-hint">Only admins can change these settings.</p>}
        <SettingField
          id="sleep_cron"
          label="Nightly sleep schedule"
          hint="Cron, in each node's local time. 0 3 * * * is 03:00 every night."
          value={value('sleep_cron')}
          validate={cronError}
          explain={cronLabel}
          canEdit={isAdmin}
        />
        <SettingField
          id="max_train_minutes"
          label="Longest training run (minutes)"
          hint="The runtime stops training after this long, so agents are never asleep for longer. 1–120."
          value={value('max_train_minutes')}
          validate={minutesError}
          canEdit={isAdmin}
          inputMode="numeric"
        />
      </section>
    </div>
  );
}
