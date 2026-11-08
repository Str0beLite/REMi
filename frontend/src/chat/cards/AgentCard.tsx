import { useId, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../../module_bindings';
import type { AgentProposal } from '../../module_bindings/types';
import { channelsLabel, checkAgentfile } from '../../agents/agentfile';
import '../../tools/tools.css';

type ViewProps = {
  p: AgentProposal;
  author: string;
  reviewer?: string;
  isAdmin: boolean;
  onDecide: (approve: boolean, note: string) => Promise<unknown>;
};

const list = (xs: readonly string[]) => (xs.length ? xs.join(', ') : 'none');

// A proposed agent: what it is for, what it may do, why; admins approve or reject with a note.
export function AgentCardView({ p, author, reviewer, isAdmin, onDecide }: ViewProps) {
  const uid = useId();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const parsed = checkAgentfile(p.agentfile);
  const af = parsed.ok ? parsed.value : undefined;
  const pending = p.status === 'pending';

  async function decide(approve: boolean) {
    setBusy(true);
    setError('');
    try {
      await onDecide(approve, note.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`tool-card is-${p.status}`} aria-label={`Proposed agent ${af?.name ?? p.id}`}>
      <header className="tool-head">
        <span className="tool-seq mono">agent proposal #{String(p.id).padStart(3, '0')}</span>
        <b className="mono">{af?.name ?? 'unreadable Agentfile'}</b>
        <span className={`tool-status st-${p.status}`}>{p.status}</span>
      </header>
      {af && <p className="tool-docs">{af.purpose}</p>}
      <p className="tool-meta">Proposed by {author}</p>
      <blockquote className="tool-docs">{p.reason}</blockquote>
      {af && (
        <dl className="tool-meta agent-card-facts">
          <dt>Tools</dt>
          <dd className="mono">{list(af.tools)}</dd>
          <dt>Channels</dt>
          <dd className="mono">{channelsLabel(af.channels)}</dd>
        </dl>
      )}
      <details className="tool-code">
        <summary>Agentfile</summary>
        <pre className="mono">{p.agentfile}</pre>
      </details>

      {pending && isAdmin ? (
        <div className="tool-review">
          <label htmlFor={`${uid}-note`}>Note to the agent (optional)</label>
          <textarea
            id={`${uid}-note`}
            name="review-note"
            rows={2}
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Why, or what to change…"
          />
          <div className="tool-actions">
            <button type="button" onClick={() => decide(false)} disabled={busy}>
              Reject
            </button>
            <button type="button" className="btn-primary" onClick={() => decide(true)} disabled={busy}>
              Approve
            </button>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <p className="tool-outcome">
          {pending
            ? 'Waiting for an admin to review it.'
            : `${p.status === 'approved' ? 'Approved' : 'Rejected'} by ${reviewer ?? 'an admin'}${p.reviewNote ? `: “${p.reviewNote}”` : ''}`}
        </p>
      )}
    </article>
  );
}

export function AgentCard({ proposalId, fallback }: { proposalId: bigint; fallback?: string }) {
  const { identity } = useSpacetimeDB();
  const [proposals] = useTable(tables.agentProposal);
  const [users] = useTable(tables.user);
  const [agents] = useTable(tables.agent);
  const review = useReducer(reducers.reviewAgent);

  const p = proposals.find(x => x.id === proposalId);
  if (!p) {
    return (
      <div className="tool-card">
        <p className="tool-docs">{fallback ?? `Agent proposal ${proposalId}`}</p>
      </div>
    );
  }
  const nick = (id: typeof identity) => (id ? users.find(u => u.identity.isEqual(id))?.nickname : undefined);
  return (
    <AgentCardView
      p={p}
      author={agents.find(a => a.id === p.authorAgent)?.name ?? `agent ${p.authorAgent}`}
      reviewer={nick(p.reviewer)}
      isAdmin={users.find(u => identity && u.identity.isEqual(identity))?.isAdmin === true}
      onDecide={(approve, note) => review({ id: p.id, approve, note })}
    />
  );
}
