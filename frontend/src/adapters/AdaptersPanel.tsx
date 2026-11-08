import { useEffect, useRef, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import type { Adapter, Agent } from '../module_bindings/types';
import { parseStats, weightIn } from './adapterData';
import { StatBars } from './StatBars';
import './adapters.css';
import '../sleep/sleep.css';

const DEBOUNCE_MS = 400;

// One agent's weight for one adapter. The slider moves locally and sends attach_adapter once it settles.
function WeightRow({ agent, adapter, canEdit }: { agent: Agent; adapter: Adapter; canEdit: boolean }) {
  const attach = useReducer(reducers.attachAdapter);
  const current = weightIn(agent.agentfile, adapter.name);
  const live = current && current.version === adapter.version ? current.weight : 0;
  const [value, setValue] = useState(live);
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [error, setError] = useState('');
  const timer = useRef<number>(undefined);

  // Follow the server when someone else changes it and we're not mid-edit.
  useEffect(() => {
    if (timer.current === undefined) setValue(live);
  }, [live]);

  function change(v: number) {
    setValue(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      timer.current = undefined;
      setState('saving');
      try {
        await attach({ agentId: agent.id, name: adapter.name, version: adapter.version, weight: v });
        setState('idle');
        setError('');
      } catch (err) {
        setState('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    }, DEBOUNCE_MS);
  }

  const id = `w-${adapter.id}-${agent.id}`;
  const other = current && current.version !== adapter.version ? `uses v${current.version}` : undefined;
  return (
    <li className="weight-row">
      <label htmlFor={id}>{agent.name}</label>
      <input
        id={id}
        name={id}
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={value}
        disabled={!canEdit || agent.protected}
        onChange={e => change(Number(e.target.value))}
        aria-valuetext={value === 0 ? 'not attached' : `weight ${value.toFixed(2)}`}
      />
      <output htmlFor={id} className="weight-value">
        {value === 0 ? 'off' : value.toFixed(2)}
      </output>
      <span className="weight-note">
        {state === 'saving' ? 'Saving…' : agent.protected ? 'protected' : other ?? ''}
      </span>
      {state === 'error' && (
        <p className="form-error weight-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

// Adapter versions, their training stats, adopt/reject, and who uses them at what weight.
export function AdaptersPanel() {
  const { identity } = useSpacetimeDB();
  const [adapters] = useTable(tables.adapter);
  const [agents] = useTable(tables.agent);
  const [nodes] = useTable(tables.node);
  const [users] = useTable(tables.user);
  const setStatus = useReducer(reducers.setAdapterStatus);
  const [error, setError] = useState('');

  const isAdmin = users.find(u => identity && u.identity.isEqual(identity))?.isAdmin === true;
  const sorted = [...adapters].sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version);
  const nodeBase = (id: bigint) => nodes.find(n => n.id === id)?.baseModel;
  const nodeName = (id: bigint) => nodes.find(n => n.id === id)?.name ?? `node ${id}`;

  async function decide(key: string, status: 'adopted' | 'rejected') {
    setError('');
    try {
      await setStatus({ key, status });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="adapters-panel">
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {sorted.length === 0 && (
        <p className="chart-empty">No adapters yet. Sleep REMi registers a candidate here after it trains one overnight.</p>
      )}
      {sorted.map(a => {
        const stats = parseStats(a.trainStats);
        // LoRAs only work on the base they were trained on, so only those agents can use this one.
        const eligible = agents.filter(g => nodeBase(g.nodeId) === a.base).sort((x, y) => x.name.localeCompare(y.name));
        return (
          <article key={a.key} className="adapter">
            <header className="adapter-head">
              <b className="mono">{a.key}</b>
              <span className={`tool-status st-${a.status === 'adopted' ? 'approved' : a.status === 'rejected' ? 'rejected' : 'pending'}`}>{a.status}</span>
              <span className="adapter-meta">
                {nodeName(a.nodeId)}
                {stats.examples !== undefined && <> · {stats.examples} examples</>}
                {stats.minutes !== undefined && <> · {stats.minutes} min</>}
                {a.parentVersion > 0 && <> · from v{a.parentVersion}</>}
              </span>
            </header>
            {a.description && <p className="adapter-desc">{a.description}</p>}
            <StatBars stats={stats} />
            {a.status === 'candidate' &&
              (isAdmin ? (
                <div className="tool-actions">
                  <button type="button" onClick={() => decide(a.key, 'rejected')}>
                    Reject
                  </button>
                  <button type="button" className="btn-primary" onClick={() => decide(a.key, 'adopted')}>
                    Adopt
                  </button>
                </div>
              ) : (
                <p className="adapter-desc">Candidate: Sleep REMi or an admin decides whether to adopt it.</p>
              ))}
            {a.status === 'adopted' && (
              <>
                <h3>Weights</h3>
                {eligible.length === 0 ? (
                  <p className="adapter-desc">No agents run on this base model.</p>
                ) : (
                  <ul className="weights">
                    {eligible.map(g => (
                      <WeightRow key={String(g.id)} agent={g} adapter={a} canEdit={isAdmin} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </article>
        );
      })}
    </div>
  );
}
