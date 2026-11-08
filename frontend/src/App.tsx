import { useMemo, useState } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from './module_bindings';
import { AppShell } from './shell/AppShell';
import { ChannelRail } from './shell/ChannelRail';
import { SwarmRail } from './swarm/SwarmRail';
import type { AgentStatus } from './components/remiLook';
import { ChatView } from './chat/ChatView';
import { NicknamePrompt } from './chat/NicknamePrompt';
import { dmLabel, hexOf, isMember, purposeOf, tsMillis, unreadIn } from './chat/model';
import { STDB_DB } from './stdb';
import { AdaptersPanel, AgentsPanel, ConfigPanel, SleepPanel, ToolsPanel } from './panels';
import './chat/chat.css';

type PanelId = 'chat' | 'agents' | 'tools' | 'adapters' | 'sleep' | 'config';
const PANELS: { id: PanelId; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'agents', label: 'Agents' },
  { id: 'tools', label: 'Tools' },
  { id: 'adapters', label: 'Adapters' },
  { id: 'sleep', label: 'Sleep' },
  { id: 'config', label: 'Config' },
];
const OTHER_PANELS = { agents: AgentsPanel, tools: ToolsPanel, adapters: AdaptersPanel, sleep: SleepPanel, config: ConfigPanel };

export default function App() {
  const { isActive, identity } = useSpacetimeDB();
  const [users, usersReady] = useTable(tables.user);
  const [channels] = useTable(tables.channel);
  const [members] = useTable(tables.member);
  const [messages] = useTable(tables.message);
  const [agents] = useTable(tables.agent);
  const [nodes] = useTable(tables.node);

  const [activeId, setActiveId] = useState<bigint>();
  const [panel, setPanel] = useState<PanelId>('chat');
  const [lastSeen, setLastSeen] = useState<Record<string, bigint>>({});

  const me = identity ? hexOf(identity) : '';
  const meRow = users.find(u => identity && u.identity.isEqual(identity));

  const sortedMessages = useMemo(() => [...messages].sort((a, b) => (a.id < b.id ? -1 : 1)), [messages]);
  const publics = useMemo(() => channels.filter(c => c.kind === 'public').sort((a, b) => a.name.localeCompare(b.name)), [channels]);
  const dms = useMemo(() => channels.filter(c => c.kind === 'dm' && isMember(c, members, me)), [channels, members, me]);

  if (!identity || !usersReady) {
    return (
      <p className="app-status" role="status">
        Connecting to {STDB_DB}…
      </p>
    );
  }
  if (!meRow) return <NicknamePrompt />;

  const general = publics.find(c => c.name === 'general') ?? publics[0];
  const active = channels.find(c => c.id === activeId) ?? general;
  const newestId = (id: bigint) => sortedMessages.filter(m => m.channelId === id).at(-1)?.id ?? 0n;

  function open(id: bigint) {
    // Mark the channel we leave and the one we enter as read up to their newest message.
    setLastSeen(s => ({ ...s, ...(active ? { [String(active.id)]: newestId(active.id) } : {}), [String(id)]: newestId(id) }));
    setActiveId(id);
    setPanel('chat');
  }

  const unread = (id: bigint) => (active && id === active.id ? 0 : unreadIn(id, sortedMessages, lastSeen[String(id)] ?? 0n));
  const title = !active ? '' : active.kind === 'dm' ? dmLabel(active, members, me, users, agents) : active.kind === 'thread' ? active.name : `# ${active.name}`;
  const Other = panel === 'chat' ? null : OTHER_PANELS[panel];

  const rail = (
    <ChannelRail
      workspace={`REMi · ${STDB_DB}`}
      channels={publics.map(c => ({ id: c.id, name: c.name, unread: unread(c.id) }))}
      dms={dms.map(c => ({ id: c.id, name: dmLabel(c, members, me, users, agents), unread: unread(c.id) }))}
      activeId={panel === 'chat' ? (active?.kind === 'thread' ? active.parentId : active?.id) : undefined}
      onSelect={open}
      user={{ nickname: meRow.nickname, isAdmin: meRow.isAdmin }}
    />
  );

  const swarm = (
    <SwarmRail
      nodes={nodes.map(n => ({ id: n.id, name: n.name, gpu: n.gpu, status: n.status }))}
      agents={agents.map(a => ({
        id: a.id,
        name: a.name,
        status: a.status as AgentStatus,
        node_id: a.nodeId,
        purpose: purposeOf(a.agentfile),
        protected: a.protected,
      }))}
      messages={sortedMessages.map(m => ({
        id: m.id,
        author_kind: m.authorKind,
        author_id: m.authorId,
        kind: m.kind,
        meta: m.meta,
        channel_id: m.channelId,
        ts: tsMillis(m),
      }))}
      channels={channels.map(c => ({ id: c.id, name: c.kind === 'public' ? `#${c.name}` : c.kind === 'thread' ? `thread ${c.name}` : 'a DM' }))}
      onOpenChannel={open}
    />
  );

  const main = (
    <>
      <header className="main-head">
        <h1>{panel === 'chat' ? title : PANELS.find(p => p.id === panel)?.label}</h1>
        {!isActive && (
          <span className="conn-badge" role="status">
            Reconnecting…
          </span>
        )}
        <nav className="panel-tabs" aria-label="Panels">
          {PANELS.map(p => (
            <button key={p.id} type="button" aria-pressed={panel === p.id} onClick={() => setPanel(p.id)}>
              {p.label}
            </button>
          ))}
        </nav>
      </header>
      {Other ? (
        <Other />
      ) : active ? (
        <ChatView
          channel={active}
          title={title}
          parent={active.kind === 'thread' ? channels.find(c => c.id === active.parentId) : undefined}
          threads={channels.filter(c => c.kind === 'thread' && c.parentId === active.id)}
          messages={sortedMessages.filter(m => m.channelId === active.id)}
          users={users}
          agents={agents}
          me={me}
          connected={isActive}
          onOpen={open}
        />
      ) : (
        <p className="app-status">No channels yet. The module creates #general and #ops when it is published.</p>
      )}
    </>
  );

  return <AppShell rail={rail} main={main} swarm={swarm} title="REMi" />;
}
