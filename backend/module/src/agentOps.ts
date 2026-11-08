// Shared agent bookkeeping for create_agent, update_agentfile, rollback_agent and review_agent.
// Not re-exported from index.ts: the module's root may only export registered reducers.
import { SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import type { Identity } from 'spacetimedb';
import db from './contract';
import type { Agentfile } from './agentfile';

export type Ctx = ReducerCtx<InferSchema<typeof db>>;

export function nameFree(ctx: Ctx, name: string, selfId: bigint) {
  const other = ctx.db.agent.name.find(name);
  if (other && other.id !== selfId) throw new SenderError(`an agent named ${name} already exists`);
}

export function logHistory(ctx: Ctx, agentId: bigint, agentfile: string) {
  ctx.db.config_history.insert({ id: 0n, agent_id: agentId, agentfile, changed_by: ctx.sender.toHexString(), ts: ctx.timestamp });
}

// Public-channel memberships follow the Agentfile `channels` list; missing channels are created.
// Thread and DM memberships are left alone.
export function syncChannels(ctx: Ctx, agentId: bigint, af: Agentfile) {
  const memberId = agentId.toString();
  const publicByName = new Map(
    [...ctx.db.channel.iter()].filter(c => c.kind === 'public').map(c => [c.name, c] as const),
  );
  const wanted = new Set<bigint>();
  for (const name of af.channels) {
    const ch =
      publicByName.get(name) ??
      ctx.db.channel.insert({ id: 0n, name, kind: 'public', parent_id: 0n, created_by: ctx.sender, ts: ctx.timestamp });
    wanted.add(ch.id);
  }
  const current = [...ctx.db.member.iter()].filter(m => m.member_kind === 'agent' && m.member_id === memberId);
  for (const m of current) {
    if (ctx.db.channel.id.find(m.channel_id)?.kind === 'public' && !wanted.has(m.channel_id)) ctx.db.member.id.delete(m.id);
  }
  const have = new Set(current.map(m => m.channel_id));
  for (const id of wanted) if (!have.has(id)) ctx.db.member.insert({ id: 0n, channel_id: id, member_kind: 'agent', member_id: memberId });
}

// A new agent exactly as create_agent makes it: idle, unprotected, history row, channel memberships.
export function insertAgent(ctx: Ctx, af: Agentfile, text: string, nodeId: bigint, owner: Identity) {
  nameFree(ctx, af.name, 0n);
  const a = ctx.db.agent.insert({ id: 0n, name: af.name, agentfile: text, status: 'idle', node_id: nodeId, owner, protected: false });
  logHistory(ctx, a.id, text);
  syncChannels(ctx, a.id, af);
  return a;
}
