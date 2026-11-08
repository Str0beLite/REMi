// Node and agent reducers: CONTRACT.md §4 register_node, heartbeat, create_agent, update_agentfile,
// set_agent_status, stop_agent, rollback_agent.
import { SenderError, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import db, { AGENT_STATUSES, NODE_STATUSES } from '../contract';
import { parseAgentfile, type Agentfile } from '../agentfile';

type Ctx = ReducerCtx<InferSchema<typeof db>>;
type AgentRow = NonNullable<ReturnType<Ctx['db']['agent']['id']['find']>>;

const callerUser = (ctx: Ctx) => ctx.db.user.identity.find(ctx.sender);
const callerNode = (ctx: Ctx) => ctx.db.node.identity.find(ctx.sender);
const isAdmin = (ctx: Ctx) => callerUser(ctx)?.is_admin === true;

function oneOf(value: string, allowed: readonly string[], what: string) {
  if (!allowed.includes(value)) throw new SenderError(`unknown ${what}: ${value}`);
}

function agentOrThrow(ctx: Ctx, id: bigint) {
  const a = ctx.db.agent.id.find(id);
  if (!a) throw new SenderError(`no agent ${id}`);
  return a;
}

function nodeOrThrow(ctx: Ctx, id: bigint) {
  const n = ctx.db.node.id.find(id);
  if (!n) throw new SenderError(`no node ${id}`);
  return n;
}

function requireCallerNodeFor(ctx: Ctx, a: AgentRow) {
  if (callerNode(ctx)?.id !== a.node_id) throw new SenderError(`only agent ${a.id}'s node can do this`);
}

function nameFree(ctx: Ctx, name: string, selfId: bigint) {
  const other = ctx.db.agent.name.find(name);
  if (other && other.id !== selfId) throw new SenderError(`an agent named ${name} already exists`);
}

function logHistory(ctx: Ctx, agentId: bigint, agentfile: string) {
  ctx.db.config_history.insert({ id: 0n, agent_id: agentId, agentfile, changed_by: ctx.sender.toHexString(), ts: ctx.timestamp });
}

// Public-channel memberships follow the Agentfile `channels` list; missing channels are created.
// Thread and DM memberships are left alone.
function syncChannels(ctx: Ctx, agentId: bigint, af: Agentfile) {
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

function applyAgentfile(ctx: Ctx, a: AgentRow, text: string) {
  const af = parseAgentfile(text);
  nameFree(ctx, af.name, a.id);
  ctx.db.agent.id.update({ ...a, name: af.name, agentfile: text });
  logHistory(ctx, a.id, text);
  syncChannels(ctx, a.id, af);
}

export const register_node = db.reducer(
  { name: t.string(), gpu: t.string(), base_model: t.string() },
  (ctx, { name, gpu, base_model }) => {
    if (!isAdmin(ctx)) throw new SenderError('only an admin can register a node');
    if (!/^[a-z0-9-]{1,32}$/.test(name)) throw new SenderError('node names are lowercase a-z, 0-9 and -, 1-32 characters');
    if (!base_model.trim()) throw new SenderError('base_model is required');
    const byName = ctx.db.node.name.find(name);
    const mine = callerNode(ctx);
    if (byName && !byName.identity.equals(ctx.sender)) throw new SenderError(`node ${name} belongs to another identity`);
    if (mine && mine.name !== name) throw new SenderError(`this identity is already node ${mine.name}`);
    if (mine) ctx.db.node.id.update({ ...mine, gpu, base_model, status: 'up', last_seen: ctx.timestamp });
    else ctx.db.node.insert({ id: 0n, identity: ctx.sender, name, gpu, base_model, status: 'up', last_seen: ctx.timestamp });
  },
);

export const heartbeat = db.reducer({ node_id: t.u64(), status: t.string() }, (ctx, { node_id, status }) => {
  const n = nodeOrThrow(ctx, node_id);
  if (!n.identity.equals(ctx.sender)) throw new SenderError('only that node can heartbeat');
  oneOf(status, NODE_STATUSES, 'node status');
  ctx.db.node.id.update({ ...n, status, last_seen: ctx.timestamp });
});

export const create_agent = db.reducer({ agentfile: t.string(), node_id: t.u64() }, (ctx, { agentfile, node_id }) => {
  if (!callerUser(ctx)) throw new SenderError('set a nickname first');
  nodeOrThrow(ctx, node_id);
  const af = parseAgentfile(agentfile);
  nameFree(ctx, af.name, 0n);
  const a = ctx.db.agent.insert({ id: 0n, name: af.name, agentfile, status: 'idle', node_id, owner: ctx.sender, protected: false });
  logHistory(ctx, a.id, agentfile);
  syncChannels(ctx, a.id, af);
});

export const update_agentfile = db.reducer({ agent_id: t.u64(), agentfile: t.string() }, (ctx, { agent_id, agentfile }) => {
  const a = agentOrThrow(ctx, agent_id);
  if (a.protected && !isAdmin(ctx)) throw new SenderError('only an admin can change a protected agent');
  if (!a.owner.equals(ctx.sender) && !isAdmin(ctx)) throw new SenderError('only the owner or an admin can edit this agent');
  applyAgentfile(ctx, a, agentfile);
});

export const set_agent_status = db.reducer({ agent_id: t.u64(), status: t.string() }, (ctx, { agent_id, status }) => {
  const a = agentOrThrow(ctx, agent_id);
  requireCallerNodeFor(ctx, a);
  oneOf(status, AGENT_STATUSES, 'agent status');
  ctx.db.agent.id.update({ ...a, status });
});

export const stop_agent = db.reducer({ agent_id: t.u64() }, (ctx, { agent_id }) => {
  const a = agentOrThrow(ctx, agent_id);
  if (!a.owner.equals(ctx.sender) && !isAdmin(ctx)) throw new SenderError('only the owner or an admin can stop this agent');
  ctx.db.agent.id.update({ ...a, status: 'stopped' });
  for (const r of ctx.db.run.agent_id.filter(agent_id)) {
    if (r.state === 'running') ctx.db.run.id.update({ ...r, state: 'stopped' });
  }
});

export const rollback_agent = db.reducer({ agent_id: t.u64(), history_id: t.u64() }, (ctx, { agent_id, history_id }) => {
  if (!isAdmin(ctx)) throw new SenderError('only an admin can roll back an agent');
  const a = agentOrThrow(ctx, agent_id);
  const h = ctx.db.config_history.id.find(history_id);
  if (!h || h.agent_id !== agent_id) throw new SenderError(`history ${history_id} is not agent ${agent_id}'s`);
  applyAgentfile(ctx, a, h.agentfile);
});
