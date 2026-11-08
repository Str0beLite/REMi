import { useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../../module_bindings';
import { adapterEventMeta, parseStats } from '../../adapters/adapterData';
import { StatBars } from '../../adapters/StatBars';
import '../../adapters/adapters.css';

const EVENT_LABEL: Record<string, string> = {
  registered: 'registered as a candidate',
  adopted: 'adopted',
  rejected: 'rejected',
  attached: 'attached',
  detached: 'detached',
  evaluated: 'evaluated',
};

const VERDICT_CLASS: Record<string, string> = { 'STRONG GO': 'is-go', 'WEAK GO': 'is-weak', 'NO-GO': 'is-nogo' };
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`;

// adapter_event: which adapter changed, its training stats, and (for attach) the agent and weight.
export function AdapterCard({ meta, body }: { meta: string; body: string }) {
  const { identity } = useSpacetimeDB();
  const [adapters] = useTable(tables.adapter);
  const [agents] = useTable(tables.agent);
  const [users] = useTable(tables.user);
  const attach = useReducer(reducers.attachAdapter);
  const [error, setError] = useState('');
  const m = adapterEventMeta(meta);
  const adapter = adapters.find(a => a.key === m.key);
  const agent = m.agentId !== undefined ? agents.find(a => a.id === m.agentId) : undefined;
  const r = m.result;
  const stats = { ...(adapter ? parseStats(adapter.trainStats) : {}), ...(r && { heldoutBase: r.base / r.n, heldoutCandidate: r.candidate / r.n }) };
  const isAdmin = users.find(u => identity && u.identity.isEqual(identity))?.isAdmin === true;

  async function detach() {
    if (!adapter || !agent) return;
    setError('');
    try {
      await attach({ agentId: agent.id, name: adapter.name, version: adapter.version, weight: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <article className="adapter adapter-card" aria-label={`Adapter ${m.key ?? ''}`}>
      <header className="adapter-head">
        <b className="mono">{m.key ?? 'adapter'}</b>
        <span>{(m.event && EVENT_LABEL[m.event]) ?? m.event}</span>
        {agent && (
          <span className="adapter-meta">
            {agent.name}
            {m.weight !== undefined && <> × {m.weight}</>}
          </span>
        )}
      </header>
      {r && (
        <p className="adapter-verdict">
          <b className={`verdict ${VERDICT_CLASS[r.verdict] ?? ''}`}>{r.verdict}</b>
          <span>
            on <span className="mono">{r.dataset}</span>: {r.candidate}/{r.n} exact with it vs {r.base}/{r.n} base,{' '}
            {signed(r.diff)} pts (95% CI {signed(r.ciLo)} to {signed(r.ciHi)})
          </span>
        </p>
      )}
      {!adapter && !r && <p className="adapter-desc">{body}</p>}
      {(adapter || r) && <StatBars stats={stats} />}
      {isAdmin && m.event === 'attached' && adapter && agent && !agent.protected && (
        <div className="tool-actions">
          <button type="button" onClick={detach}>
            Detach from {agent.name}
          </button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
