import { useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import { RemiAvatar } from '../components/RemiAvatar';
import { defaultLook, type AgentStatus } from '../components/remiLook';
import { AgentEditor } from './AgentEditor';
import { TEMPLATES } from './agentfile';
import './agents.css';

const when = (t: { microsSinceUnixEpoch: bigint }) =>
  new Date(Number(t.microsSinceUnixEpoch / 1000n)).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

// Every REMi with its live status, plus the Agentfile editor (create, edit, stop, roll back).
export function AgentsPanel() {
  const { identity } = useSpacetimeDB();
  const [agents] = useTable(tables.agent);
  const [nodes] = useTable(tables.node);
  const [users] = useTable(tables.user);
  const [history] = useTable(tables.configHistory);
  const createAgent = useReducer(reducers.createAgent);
  const updateAgentfile = useReducer(reducers.updateAgentfile);
  const stopAgent = useReducer(reducers.stopAgent);
  const rollbackAgent = useReducer(reducers.rollbackAgent);
  const [selected, setSelected] = useState<bigint | 'new'>();
  const [actionError, setActionError] = useState('');
  // Stop has no Resume in the UI, so it takes a second click to confirm.
  const [confirmStop, setConfirmStop] = useState<bigint>();

  const me = users.find(u => identity && u.identity.isEqual(identity));
  const isAdmin = me?.isAdmin === true;
  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  const agent = typeof selected === 'bigint' ? agents.find(a => a.id === selected) : undefined;
  const nodeName = (id: bigint) => nodes.find(n => n.id === id)?.name ?? `node ${id}`;
  const nickOf = (hex: string) => users.find(u => u.identity.toHexString() === hex)?.nickname ?? `${hex.slice(0, 8)}…`;

  async function act(fn: () => Promise<void>) {
    setActionError('');
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  const readOnlyReason = !agent
    ? undefined
    : agent.protected && !isAdmin
      ? 'Protected agent: only an admin can change it.'
      : !isAdmin && !(identity && agent.owner.isEqual(identity))
        ? 'Only its owner or an admin can edit this agent.'
        : undefined;

  const agentHistory = agent ? [...history].filter(h => h.agentId === agent.id).sort((a, b) => (a.id > b.id ? -1 : 1)) : [];

  return (
    <div className="agents">
      <aside className="agents-list" aria-label="Agents">
        <button type="button" className="btn-primary agents-new" onClick={() => setSelected('new')}>
          New agent
        </button>
        {sorted.length === 0 && <p className="agents-empty">No REMis yet. Create one from a template.</p>}
        <ul>
          {sorted.map(a => {
            const look = defaultLook(a);
            return (
              <li key={String(a.id)}>
                <button type="button" className="agent-row" aria-current={selected === a.id ? 'true' : undefined} onClick={() => setSelected(a.id)}>
                  <RemiAvatar status={a.status as AgentStatus} headgear={look.headgear} tint={look.tint} size={32} />
                  <span className="agent-row-text">
                    <b>{a.name}</b>
                    <small>{nodeName(a.nodeId)}</small>
                  </span>
                  <span className={`agent-status status-${a.status}`}>
                    <i aria-hidden="true" />
                    {a.status}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="agents-detail">
        {selected === 'new' ? (
          <>
            <h2>New agent</h2>
            <AgentEditor
              key="new"
              mode="create"
              initialText={TEMPLATES[0].text}
              nodes={nodes}
              onCancel={() => setSelected(undefined)}
              onSubmit={async (text, nodeId) => {
                await createAgent({ agentfile: text, nodeId: nodeId! });
                setSelected(undefined);
              }}
            />
          </>
        ) : agent ? (
          <>
            <header className="agent-head">
              <RemiAvatar status={agent.status as AgentStatus} {...defaultLook(agent)} size={48} />
              <div>
                <h2>{agent.name}</h2>
                <p>
                  <span className={`status-${agent.status}`}>{agent.status}</span> · {nodeName(agent.nodeId)}
                  {agent.protected && ' · protected'}
                </p>
              </div>
              {isAdmin &&
                (confirmStop === agent.id && agent.status !== 'stopped' ? (
                  <span className="agent-stop-confirm" role="group" aria-label={`Stop ${agent.name}?`}>
                    <button
                      type="button"
                      className="agent-stop"
                      autoFocus
                      onClick={() => {
                        setConfirmStop(undefined);
                        act(() => stopAgent({ agentId: agent.id }));
                      }}
                    >
                      Stop {agent.name}
                    </button>
                    <button type="button" onClick={() => setConfirmStop(undefined)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button type="button" className="agent-stop" disabled={agent.status === 'stopped'} onClick={() => setConfirmStop(agent.id)}>
                    {agent.status === 'stopped' ? 'Stopped' : 'Stop…'}
                  </button>
                ))}
            </header>
            {actionError && (
              <p className="form-error" role="alert">
                {actionError}
              </p>
            )}
            <AgentEditor
              key={`${agent.id}-${agent.agentfile}`}
              mode="edit"
              initialText={agent.agentfile}
              readOnlyReason={readOnlyReason}
              onSubmit={text => updateAgentfile({ agentId: agent.id, agentfile: text })}
            />
            <h3 className="history-title">History</h3>
            <ol className="history">
              {agentHistory.map((h, i) => (
                <li key={String(h.id)}>
                  <span>
                    {when(h.ts)} · {nickOf(h.changedBy)}
                    {i === 0 && <em> · current</em>}
                  </span>
                  {isAdmin && i > 0 && (
                    <button type="button" onClick={() => act(() => rollbackAgent({ agentId: agent.id, historyId: h.id }))}>
                      Roll back to this
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="agents-empty">Pick a REMi to see and edit its Agentfile, or create a new one.</p>
        )}
      </section>
    </div>
  );
}
