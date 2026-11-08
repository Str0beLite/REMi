import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { ToolCard } from '../chat/cards/ToolCard';
import { firstLine } from './toolView';
import './tools.css';

// The registry: tools waiting for review as full cards, then every reviewed version.
export function ToolsPanel() {
  const [tools] = useTable(tables.tool);
  const [agents] = useTable(tables.agent);
  const byNewest = [...tools].sort((a, b) => (a.id > b.id ? -1 : 1));
  const pending = byNewest.filter(t => t.status === 'pending');
  const reviewed = byNewest.filter(t => t.status !== 'pending');
  const author = (id: bigint) => agents.find(a => a.id === id)?.name ?? `agent ${id}`;

  return (
    <div className="tools-panel">
      <section>
        <h2>
          Waiting for review {pending.length > 0 && <span className="count">{pending.length}</span>}
        </h2>
        {pending.length === 0 ? (
          <p className="tools-empty">Nothing to review. When a REMi runs /propose_tool, its card shows up here and in the channel.</p>
        ) : (
          <div className="tools-pending">
            {pending.map(t => (
              <ToolCard key={t.key} toolKey={t.key} />
            ))}
          </div>
        )}
      </section>
      <section>
        <h2>Registry</h2>
        {reviewed.length === 0 ? (
          <p className="tools-empty">No tools reviewed yet.</p>
        ) : (
          <div className="tools-table-wrap">
            <table className="tools-table">
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col">Status</th>
                  <th scope="col">What it does</th>
                  <th scope="col">Proposed by</th>
                </tr>
              </thead>
              <tbody>
                {reviewed.map(t => (
                  <tr key={t.key}>
                    <td className="mono">{t.key}</td>
                    <td>
                      <span className={`tool-status st-${t.status}`}>{t.status}</span>
                    </td>
                    <td>{firstLine(t.docs)}</td>
                    <td>{author(t.authorAgent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
