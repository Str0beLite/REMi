// Datasets and adapters: CONTRACT.md §4 register_dataset, register_adapter, set_adapter_status, attach_adapter.
import { SenderError, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { stringify } from 'yaml';
import db, { ADAPTER_STATUSES } from '../contract';
import { parseAgentfile } from '../agentfile';
import { requireJsonObject } from '../agentOps';

type Ctx = ReducerCtx<InferSchema<typeof db>>;

const DATASET_NAME = /^[a-z0-9-]{1,48}$/;
const ADAPTER_NAME = /^[a-z0-9-]{1,48}$/;

const callerNode = (ctx: Ctx) => ctx.db.node.identity.find(ctx.sender);
const isAdmin = (ctx: Ctx) => ctx.db.user.identity.find(ctx.sender)?.is_admin === true;

// The node that runs a protected agent (Sleep REMi) gets adapter rights, alongside admins.
function isProtectedAgentsNode(ctx: Ctx) {
  const n = callerNode(ctx);
  return !!n && [...ctx.db.agent.iter()].some(a => a.protected && a.node_id === n.id);
}

function requireThatNode(ctx: Ctx, nodeId: bigint) {
  const n = ctx.db.node.id.find(nodeId);
  if (!n) throw new SenderError(`no node ${nodeId}`);
  if (!n.identity.equals(ctx.sender)) throw new SenderError(`only node ${nodeId} can register this`);
  return n;
}

export const register_dataset = db.reducer(
  { name: t.string(), node_id: t.u64(), n_examples: t.u32(), sha256: t.string(), description: t.string(), created_by: t.string() },
  (ctx, { name, node_id, n_examples, sha256, description, created_by }) => {
    requireThatNode(ctx, node_id);
    if (!DATASET_NAME.test(name)) throw new SenderError('dataset names are lowercase a-z, 0-9 and -, 1-48 characters');
    const row = { name, node_id, n_examples, sha256, description, created_by, ts: ctx.timestamp };
    if (ctx.db.dataset.name.find(name)) ctx.db.dataset.name.update(row);
    else ctx.db.dataset.insert(row);
  },
);

export const register_adapter = db.reducer(
  {
    name: t.string(),
    version: t.u32(),
    node_id: t.u64(),
    base: t.string(),
    description: t.string(),
    sha256: t.string(),
    size: t.u64(),
    train_stats: t.string(),
    parent_version: t.u32(),
    dataset_names: t.string(),
  },
  (ctx, args) => {
    const n = requireThatNode(ctx, args.node_id);
    if (!ADAPTER_NAME.test(args.name)) throw new SenderError('adapter names are lowercase a-z, 0-9 and -, 1-48 characters');
    if (args.version < 1) throw new SenderError('adapter versions start at 1');
    if (args.base !== n.base_model) throw new SenderError(`adapter base ${args.base} is not this node's base ${n.base_model}`);
    requireJsonObject(args.train_stats, 'train_stats');
    const key = `${args.name}@${args.version}`;
    if (ctx.db.adapter.key.find(key)) throw new SenderError(`adapter ${key} already exists`);
    ctx.db.adapter.insert({ id: 0n, key, ...args, status: 'candidate', ts: ctx.timestamp });
  },
);

export const set_adapter_status = db.reducer({ key: t.string(), status: t.string() }, (ctx, { key, status }) => {
  if (!isAdmin(ctx) && !isProtectedAgentsNode(ctx)) throw new SenderError('only an admin or Sleep REMi can change adapter status');
  if (!(ADAPTER_STATUSES as readonly string[]).includes(status)) throw new SenderError(`unknown adapter status: ${status}`);
  const a = ctx.db.adapter.key.find(key);
  if (!a) throw new SenderError(`no adapter ${key}`);
  ctx.db.adapter.id.update({ ...a, status });
});

export const attach_adapter = db.reducer(
  { agent_id: t.u64(), name: t.string(), version: t.u32(), weight: t.f32() },
  (ctx, { agent_id, name, version, weight }) => {
    const admin = isAdmin(ctx);
    if (!admin && !isProtectedAgentsNode(ctx)) throw new SenderError('only an admin or Sleep REMi can attach adapters');
    const agent = ctx.db.agent.id.find(agent_id);
    if (!agent) throw new SenderError(`no agent ${agent_id}`);
    // The judge is never the judged: only an admin changes a protected agent's mix.
    if (agent.protected && !admin) throw new SenderError('only an admin can attach adapters to a protected agent');
    if (!(weight >= 0 && weight <= 2)) throw new SenderError('weight must be between 0 and 2');
    const key = `${name}@${version}`;
    const adapter = ctx.db.adapter.key.find(key);
    if (!adapter) throw new SenderError(`no adapter ${key}`);
    if (adapter.status !== 'adopted') throw new SenderError(`adapter ${key} is ${adapter.status}, not adopted`);
    const node = ctx.db.node.id.find(agent.node_id);
    if (!node || adapter.base !== node.base_model)
      throw new SenderError(`adapter ${key} was trained on ${adapter.base}, not this agent's base ${node?.base_model ?? '?'}`);
    const here = adapter.node_id === agent.node_id || [...ctx.db.adapter_copy.key.filter(key)].some(c => c.node_id === agent.node_id);
    if (!here) throw new SenderError(`adapter ${key}'s files aren't on ${node.name}; move the agent to a node that has them`);

    const af = parseAgentfile(agent.agentfile);
    const w = Math.round(weight * 100) / 100;
    af.adapters = af.adapters.filter(x => x.name !== name);
    if (w > 0) af.adapters.push({ name, version, weight: w });
    const text = stringify(af);
    parseAgentfile(text);
    ctx.db.agent.id.update({ ...agent, agentfile: text });
    ctx.db.config_history.insert({ id: 0n, agent_id, agentfile: text, changed_by: ctx.sender.toHexString(), ts: ctx.timestamp });
  },
);
