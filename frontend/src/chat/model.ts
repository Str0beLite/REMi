// Plain helpers over the generated rows: names, DM labels, purposes, unread counts.
import type { Identity } from 'spacetimedb';
import type { Agent, Channel, Member, Message, User } from '../module_bindings/types';

export const hexOf = (id: Identity) => id.toHexString();

export const tsMillis = (m: { ts: { microsSinceUnixEpoch: bigint } }) => Number(m.ts.microsSinceUnixEpoch / 1000n);

export function timeLabel(m: Message) {
  return new Date(tsMillis(m)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// First line of the Agentfile `purpose` (a YAML string, often a block scalar).
export function purposeOf(agentfile: string) {
  const m = agentfile.match(/^purpose:[ \t]*(?:[|>][-+]?[ \t]*\n[ \t]+)?(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

export type Author = { kind: 'user' | 'agent' | 'system'; name: string; agent?: Agent };

export function authorOf(m: Message, users: readonly User[], agents: readonly Agent[]): Author {
  if (m.authorKind === 'agent') {
    const agent = agents.find(a => String(a.id) === m.authorId);
    return { kind: 'agent', name: agent?.name ?? `agent ${m.authorId}`, agent };
  }
  if (m.authorKind === 'user') {
    const u = users.find(x => hexOf(x.identity) === m.authorId);
    return { kind: 'user', name: u?.nickname ?? 'someone' };
  }
  return { kind: 'system', name: 'REMi' };
}

// A DM is named after the other member(s) the viewer can see.
export function dmLabel(c: Channel, members: readonly Member[], me: string, users: readonly User[], agents: readonly Agent[]) {
  const others = members
    .filter(m => m.channelId === c.id && !(m.memberKind === 'user' && m.memberId === me))
    .map(m =>
      m.memberKind === 'agent'
        ? agents.find(a => String(a.id) === m.memberId)?.name
        : users.find(u => hexOf(u.identity) === m.memberId)?.nickname,
    )
    .filter(Boolean);
  return others.length ? others.join(', ') : 'Direct message';
}

export function isMember(c: Channel, members: readonly Member[], me: string) {
  return members.some(m => m.channelId === c.id && m.memberKind === 'user' && m.memberId === me);
}

export function unreadIn(channelId: bigint, messages: readonly Message[], lastSeen: bigint | undefined) {
  if (lastSeen === undefined) return 0;
  let n = 0;
  for (const m of messages) if (m.channelId === channelId && m.id > lastSeen) n++;
  return n;
}

// The `@query` being typed right before the caret, or null. Mirrors the runtime's matcher:
// an @ that doesn't follow a word character or '-', so me@host.com doesn't count.
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|[^\w-])@([\w-]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[1].length - 1, query: m[1] } : null;
}

export type MentionOption = { kind: 'agent'; name: string; agent: Agent } | { kind: 'user'; name: string };

// REMis before people; names starting with the query before ones that only contain it.
export function mentionMatches(query: string, agents: readonly Agent[], users: readonly User[], me: string, limit = 6): MentionOption[] {
  const q = query.toLowerCase();
  const all: MentionOption[] = [
    ...agents.map(agent => ({ kind: 'agent' as const, name: agent.name, agent })),
    // Nicknames with spaces can't be @mentioned as one word, so they're left out.
    ...users.filter(u => hexOf(u.identity) !== me && !/\s/.test(u.nickname)).map(u => ({ kind: 'user' as const, name: u.nickname })),
  ];
  const rank = (o: MentionOption) => {
    const n = o.name.toLowerCase();
    return n.startsWith(q) ? 0 : n.includes(q) ? 1 : -1;
  };
  return all
    .map((o, i) => ({ o, r: rank(o), i }))
    .filter(x => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map(x => x.o);
}

// Feed items: a message, or a run of back-to-back tool_call/tool_result messages from one agent shown as one block.
export type ToolStep = { call?: Message; result?: Message };
export type FeedItem = { kind: 'msg'; m: Message } | { kind: 'tools'; first: Message; steps: ToolStep[] };

const isTool = (m: Message) => m.kind === 'tool_call' || m.kind === 'tool_result';

export function feedItems(messages: readonly Message[]): FeedItem[] {
  const out: FeedItem[] = [];
  for (const m of messages) {
    if (!isTool(m)) {
      out.push({ kind: 'msg', m });
      continue;
    }
    const prev = out.at(-1);
    const run = prev?.kind === 'tools' && prev.first.authorKind === m.authorKind && prev.first.authorId === m.authorId ? prev : null;
    const steps = run ? run.steps : [];
    if (!run) out.push({ kind: 'tools', first: m, steps });
    const open = steps.at(-1);
    // a result closes the call before it; anything else starts a new step
    if (m.kind === 'tool_result' && open?.call && !open.result) open.result = m;
    else steps.push(m.kind === 'tool_call' ? { call: m } : { result: m });
  }
  return out;
}

export type ToolMeta = { command?: string; exit_code?: number; ms?: number };
export function toolMeta(m?: Message): ToolMeta {
  try {
    const v = JSON.parse(m?.meta ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// Same rule as the runtime's poller: @name as a whole word, any case (not @name-2, not me@name.com).
export function mentionsName(body: string, name: string) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])@${esc}(?![\\w-])`, 'i').test(body);
}
