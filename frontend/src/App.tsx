import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from './module_bindings';
import { AppShell } from './shell/AppShell';
import { ChannelRail } from './shell/ChannelRail';
import { SwarmRail } from './swarm/SwarmRail';
import { addMachineFocus } from './nodes/joinCommand';
import { equipmentOf } from './swarm/swarmData';
import type { AgentStatus } from './components/remiLook';
import { ChatView } from './chat/ChatView';
import { NicknamePrompt } from './chat/NicknamePrompt';
import { dmLabel, hexOf, isMember, purposeOf, tsMillis, unreadIn } from './chat/model';
import { STDB_DB } from './stdb';
import { AdaptersPanel, AgentsPanel, ConfigPanel, SleepPanel, ToolsPanel } from './panels';
import { readRoute, writeRoute, type PanelId, type Route } from './route';
import { confirmLeave } from './unsaved';
import { useAdminClaim } from './admin/claim';
import { ClaimNotice, GetStarted } from './onboarding/GetStarted';
import { getStartedSteps } from './onboarding/steps';
import './chat/chat.css';

const PANELS: { id: PanelId; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'agents', label: 'Agents' },
  { id: 'tools', label: 'Tools' },
  { id: 'adapters', label: 'Adapters' },
  { id: 'sleep', label: 'Sleep' },
  { id: 'config', label: 'Config' },
];
const OTHER_PANELS = { agents: AgentsPanel, tools: ToolsPanel, adapters: AdaptersPanel, sleep: SleepPanel, config: ConfigPanel };

// The tab title carries the view and the unread count, since REMi sits in a background tab all day.
function DocTitle({ text }: { text: string }) {
  useEffect(() => {
    document.title = text;
  }, [text]);
  return null;
}

export default function App() {
  const { isActive, identity } = useSpacetimeDB();
  const [users, usersReady] = useTable(tables.user);
  const [channels] = useTable(tables.channel);
  const [members] = useTable(tables.member);
  const [messages] = useTable(tables.message);
  const [agents] = useTable(tables.agent);
  const [nodes] = useTable(tables.node);

  const [route, setRoute] = useState(() => readRoute(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(readRoute(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = (r: Route) => {
    if (writeRoute(r) === location.hash || !confirmLeave()) return;
    location.hash = writeRoute(r); // pushes history; the hashchange listener updates state
  };
  const { panel, channelId: activeId } = route;
  const [lastSeen, setLastSeen] = useState<Record<string, bigint>>({});

  const me = identity ? hexOf(identity) : '';
  const meRow = users.find(u => identity && u.identity.isEqual(identity));

  const sortedMessages = useMemo(() => [...messages].sort((a, b) => (a.id < b.id ? -1 : 1)), [messages]);
  const publics = useMemo(() => channels.filter(c => c.kind === 'public').sort((a, b) => a.name.localeCompare(b.name)), [channels]);
  const dms = useMemo(() => channels.filter(c => c.kind === 'dm' && isMember(c, members, me)), [channels, members, me]);

  // Mark the channel we leave and the one we enter as read, however we moved (click, back/forward, link).
  const shownId = channels.some(c => c.id === activeId) ? activeId : (publics.find(c => c.name === 'general') ?? publics[0])?.id;
  const latest = useRef(sortedMessages);
  latest.current = sortedMessages;
  const prevShown = useRef<bigint>(undefined);
  useEffect(() => {
    const newest = (id: bigint) => latest.current.filter(m => m.channelId === id).at(-1)?.id ?? 0n;
    const prev = prevShown.current;
    prevShown.current = shownId;
    if (shownId === undefined) return;
    setLastSeen(s => ({ ...s, ...(prev !== undefined ? { [String(prev)]: newest(prev) } : {}), [String(shownId)]: newest(shownId) }));
  }, [shownId]);

  // A new channel gets its id from the module, so open it by name once its row arrives.
  const createChannel = useReducer(reducers.createChannel);
  const [openNew, setOpenNew] = useState('');
  useEffect(() => {
    const c = openNew && publics.find(p => p.name === openNew);
    if (!c) return;
    setOpenNew('');
    go({ panel: 'chat', channelId: c.id });
  }, [openNew, publics]);

  const claim = useAdminClaim(!!meRow);
  const [claimSeen, setClaimSeen] = useState(false);

  if (!identity || !usersReady) {
    return (
      <p className="app-status" role="status">
        Connecting to {STDB_DB}…
      </p>
    );
  }
  if (!meRow) return <NicknamePrompt workspace={STDB_DB} adminLink={claim.state === 'pending'} />;

  const general = publics.find(c => c.name === 'general') ?? publics[0];
  const active = channels.find(c => c.id === activeId) ?? general;

  function open(id: bigint) {
    go({ panel: 'chat', channelId: id });
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
      onCreate={async name => {
        await createChannel({ name, kind: 'public', parentId: 0n });
        setOpenNew(name);
      }}
      user={{ nickname: meRow.nickname, isAdmin: meRow.isAdmin }}
    />
  );

  const swarm = (
    <SwarmRail
      nodes={nodes.map(n => ({ id: n.id, name: n.name, gpu: n.gpu, status: n.status, base_model: n.baseModel, stats: n.stats }))}
      agents={agents.map(a => ({
        id: a.id,
        name: a.name,
        status: a.status as AgentStatus,
        node_id: a.nodeId,
        purpose: purposeOf(a.agentfile),
        protected: a.protected,
        ...equipmentOf(a.agentfile),
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
      onAddMachine={
        meRow.isAdmin
          ? () => {
              addMachineFocus.pending = true;
              go({ panel: 'config', channelId: active?.id });
            }
          : undefined
      }
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
            <button key={p.id} type="button" aria-pressed={panel === p.id} onClick={() => go({ panel: p.id, channelId: active?.id })}>
              {p.label}
            </button>
          ))}
        </nav>
      </header>
      {Other ? (
        <Other />
      ) : active ? (
        <ChatView
          top={
            <>
              {!claimSeen && <ClaimNotice claim={claim} workspace={STDB_DB} isAdmin={meRow.isAdmin} onDismiss={() => setClaimSeen(true)} />}
              {active.id === general?.id && (
                <GetStarted
                  workspace={STDB_DB}
                  steps={getStartedSteps(nodes, agents, messages)}
                  onCreateRemi={() => {
                    if (confirmLeave()) location.hash = '#/agents/new';
                  }}
                />
              )}
            </>
          }
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

  const totalUnread = [...publics, ...dms].reduce((n, c) => n + unread(c.id), 0);
  const view = panel === 'chat' ? title : (PANELS.find(p => p.id === panel)?.label ?? '');
  return (
    <>
      <DocTitle text={`${totalUnread ? `(${totalUnread}) ` : ''}${view ? `${view} · ` : ''}REMi`} />
      <AppShell rail={rail} main={main} swarm={swarm} title={view || 'REMi'} />
    </>
  );
}
