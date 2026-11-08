import { useId, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../../module_bindings';
import { firstLine, parseDryRun } from '../../tools/toolView';
import '../../tools/tools.css';

// A proposed tool as a card: docs, code, dry-run output; admins approve or reject with a note.
export function ToolCard({ toolKey, fallback }: { toolKey: string; fallback?: string }) {
  const uid = useId();
  const { identity } = useSpacetimeDB();
  const [tools] = useTable(tables.tool);
  const [users] = useTable(tables.user);
  const [agents] = useTable(tables.agent);
  const review = useReducer(reducers.reviewTool);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const tool = tools.find(t => t.key === toolKey);
  if (!tool) {
    return (
      <div className="tool-card">
        <p className="tool-docs">{fallback ?? `Tool ${toolKey}`}</p>
      </div>
    );
  }

  const isAdmin = users.find(u => identity && u.identity.isEqual(identity))?.isAdmin === true;
  const author = agents.find(a => a.id === tool.authorAgent)?.name ?? `agent ${tool.authorAgent}`;
  const reviewer = tool.reviewer ? (users.find(u => u.identity.isEqual(tool.reviewer!))?.nickname ?? 'an admin') : undefined;
  const dry = parseDryRun(tool.dryRun);
  const lines = tool.code.split('\n').length;
  const pending = tool.status === 'pending';

  async function decide(approve: boolean) {
    setBusy(true);
    setError('');
    try {
      await review({ key: tool!.key, approve, note: note.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`tool-card is-${tool.status}`} aria-label={`Tool ${tool.key}`}>
      <header className="tool-head">
        <span className="tool-seq mono">tool #{String(tool.id).padStart(3, '0')}</span>
        <b className="mono">
          /{tool.name} <span className="tool-ver">v{tool.version}</span>
        </b>
        <span className={`tool-status st-${tool.status}`}>{tool.status}</span>
      </header>
      <p className="tool-docs">{firstLine(tool.docs) || 'No docs.'}</p>
      <p className="tool-meta">Proposed by {author}</p>

      <div className="tool-dry">
        <span className="tool-dry-label">
          Dry run{dry.exitCode !== undefined && <> · exit {dry.exitCode}</>}
          {dry.ms !== undefined && <> · {dry.ms} ms</>}
        </span>
        <pre className="mono">{dry.output || '(no output)'}</pre>
      </div>

      <details className="tool-code">
        <summary>
          Code · {lines} {lines === 1 ? 'line' : 'lines'}
        </summary>
        <pre className="mono">{tool.code}</pre>
        {tool.docs.trim().includes('\n') && <pre className="tool-docs-full">{tool.docs.trim()}</pre>}
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
            : `${tool.status === 'approved' ? 'Approved' : 'Rejected'} by ${reviewer}${tool.reviewNote ? `: “${tool.reviewNote}”` : ''}`}
        </p>
      )}
    </article>
  );
}
