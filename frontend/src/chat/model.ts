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
