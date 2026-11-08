import { useState } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { FilesView } from './FilesView';
import './files.css';

// Quick access to every REMi's sandbox files you're allowed to see (its owner, or any admin): pick one, browse it.
export function FilesPanel() {
  const { identity } = useSpacetimeDB();
  const [agents] = useTable(tables.agent);
  const [nodes] = useTable(tables.node);
  const [users] = useTable(tables.user);
  const isAdmin = !!users.find(u => identity && u.identity.isEqual(identity))?.isAdmin;
  const mine = agents
    .filter(a => isAdmin || (!!identity && a.owner.isEqual(identity)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const [pick, setPick] = useState<bigint>();
  const agent = mine.find(a => a.id === pick) ?? mine[0];

  if (!agent) return <p className="files-hint">No REMis whose files you can open. Their owner or an admin can.</p>;
  return (
    <section className="files-panel" aria-label="Files">
      <div className="seg files-pick" role="tablist" aria-label="REMi">
        {mine.map(a => (
          <button key={String(a.id)} type="button" role="tab" aria-selected={a.id === agent.id} onClick={() => setPick(a.id)}>
            {a.name}
          </button>
        ))}
      </div>
      <FilesView
        key={`files-${agent.id}`}
        agent={agent}
        nodeName={nodes.find(n => n.id === agent.nodeId)?.name ?? '?'}
        me={identity}
        canBrowse
      />
    </section>
  );
}
