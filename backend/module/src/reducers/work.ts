// Tool registry, memory, todos, runs and settings: CONTRACT.md §4 propose_tool, review_tool,
// add_memory, edit_memory, todo_add, todo_done, run_start, run_turn, run_end, set_setting.
import { SenderError, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import db, { RESERVED_TOOLS, RUN_STATES } from '../contract';

type Ctx = ReducerCtx<InferSchema<typeof db>>;

const TOOL_NAME = /^[a-z][a-z0-9_]{1,31}$/;
const MAX_MEMORY = 2_000;

const callerNode = (ctx: Ctx) => ctx.db.node.identity.find(ctx.sender);
const isAdmin = (ctx: Ctx) => ctx.db.user.identity.find(ctx.sender)?.is_admin === true;

function agentOrThrow(ctx: Ctx, id: bigint) {
  const a = ctx.db.agent.id.find(id);
  if (!a) throw new SenderError(`no agent ${id}`);
  return a;
}

const isAgentsNode = (ctx: Ctx, agentId: bigint) => {
  const n = callerNode(ctx);
  return !!n && agentOrThrow(ctx, agentId).node_id === n.id;
};

function requireAgentsNode(ctx: Ctx, agentId: bigint) {
  if (!isAgentsNode(ctx, agentId)) throw new SenderError(`only agent ${agentId}'s node can do this`);
}

function checkText(text: string, max: number, what: string) {
  if (!text.trim()) throw new SenderError(`${what} is empty`);
  if (text.length > max) throw new SenderError(`${what} is over ${max} characters`);
}

function runOrThrow(ctx: Ctx, id: bigint) {
  const r = ctx.db.run.id.find(id);
  if (!r) throw new SenderError(`no run ${id}`);
  requireAgentsNode(ctx, r.agent_id);
  if (r.state !== 'running') throw new SenderError(`run ${id} already ended (${r.state})`);
  return r;
}

export const propose_tool = db.reducer(
  { name: t.string(), code: t.string(), docs: t.string(), author_agent: t.u64(), dry_run: t.string() },
  (ctx, { name, code, docs, author_agent, dry_run }) => {
    requireAgentsNode(ctx, author_agent);
    if (!TOOL_NAME.test(name)) throw new SenderError('tool names are a-z, 0-9 and _, starting with a letter, 2-32 characters');
    if ((RESERVED_TOOLS as readonly string[]).includes(name)) throw new SenderError(`${name} is a built-in command`);
    if (!code.trim()) throw new SenderError('tool code is empty');
    let parsed: unknown;
    try {
      parsed = JSON.parse(dry_run);
    } catch {
      throw new SenderError('dry_run is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new SenderError('dry_run must be a JSON object');
    const last = [...ctx.db.tool.iter()].filter(x => x.name === name).reduce((m, x) => Math.max(m, x.version), 0);
    const version = last + 1;
    ctx.db.tool.insert({
      id: 0n,
      key: `${name}@${version}`,
      name,
      version,
      code,
      docs,
      status: 'pending',
      author_agent,
      dry_run,
      reviewer: undefined,
      review_note: '',
      ts: ctx.timestamp,
    });
  },
);

export const review_tool = db.reducer({ key: t.string(), approve: t.bool(), note: t.string() }, (ctx, { key, approve, note }) => {
  if (!isAdmin(ctx)) throw new SenderError('only an admin can review tools');
  const tool = ctx.db.tool.key.find(key);
  if (!tool) throw new SenderError(`no tool ${key}`);
  if (tool.status !== 'pending') throw new SenderError(`${key} was already ${tool.status}`);
  ctx.db.tool.id.update({ ...tool, status: approve ? 'approved' : 'rejected', reviewer: ctx.sender, review_note: note });
});

export const add_memory = db.reducer({ agent_id: t.u64(), text: t.string() }, (ctx, { agent_id, text }) => {
  agentOrThrow(ctx, agent_id);
  if (!isAgentsNode(ctx, agent_id) && !isAdmin(ctx)) throw new SenderError(`only agent ${agent_id}'s node or an admin can add memories`);
  checkText(text, MAX_MEMORY, 'memory');
  ctx.db.memory.insert({ id: 0n, agent_id, text, ts: ctx.timestamp });
});

// Any node may edit (Sleep REMi's /memory edit goes through its node), or an admin.
export const edit_memory = db.reducer({ memory_id: t.u64(), text: t.string() }, (ctx, { memory_id, text }) => {
  if (!callerNode(ctx) && !isAdmin(ctx)) throw new SenderError('only a node or an admin can edit memories');
  const m = ctx.db.memory.id.find(memory_id);
  if (!m) throw new SenderError(`no memory ${memory_id}`);
  checkText(text, MAX_MEMORY, 'memory');
  ctx.db.memory.id.update({ ...m, text, ts: ctx.timestamp });
});

export const todo_add = db.reducer({ agent_id: t.u64(), text: t.string() }, (ctx, { agent_id, text }) => {
  requireAgentsNode(ctx, agent_id);
  checkText(text, MAX_MEMORY, 'todo');
  ctx.db.todo.insert({ id: 0n, agent_id, text, status: 'open', ts: ctx.timestamp });
});

export const todo_done = db.reducer({ todo_id: t.u64() }, (ctx, { todo_id }) => {
  const td = ctx.db.todo.id.find(todo_id);
  if (!td) throw new SenderError(`no todo ${todo_id}`);
  requireAgentsNode(ctx, td.agent_id);
  ctx.db.todo.id.update({ ...td, status: 'done' });
});

export const run_start = db.reducer(
  { agent_id: t.u64(), channel_id: t.u64(), trigger_msg_id: t.u64() },
  (ctx, { agent_id, channel_id, trigger_msg_id }) => {
    requireAgentsNode(ctx, agent_id);
    if (!ctx.db.channel.id.find(channel_id)) throw new SenderError(`no channel ${channel_id}`);
    if ([...ctx.db.run.agent_id.filter(agent_id)].some(r => r.channel_id === channel_id && r.state === 'running'))
      throw new SenderError(`agent ${agent_id} already has a running run in channel ${channel_id}`);
    ctx.db.run.insert({ id: 0n, agent_id, channel_id, trigger_msg_id, turns: 0, started: ctx.timestamp, state: 'running' });
  },
);

export const run_turn = db.reducer({ run_id: t.u64() }, (ctx, { run_id }) => {
  const r = runOrThrow(ctx, run_id);
  ctx.db.run.id.update({ ...r, turns: r.turns + 1 });
});

export const run_end = db.reducer({ run_id: t.u64(), state: t.string() }, (ctx, { run_id, state }) => {
  if (!RUN_STATES.includes(state as (typeof RUN_STATES)[number]) || state === 'running')
    throw new SenderError(`unknown end state: ${state}`);
  const r = runOrThrow(ctx, run_id);
  ctx.db.run.id.update({ ...r, state });
});

export const set_setting = db.reducer({ key: t.string(), value: t.string() }, (ctx, { key, value }) => {
  // Sleep REMi's node records its last sleep; on a joined machine that node isn't an admin (#84).
  if (!isAdmin(ctx) && !(key === 'last_sleep_ts' && callerNode(ctx))) throw new SenderError('only an admin can change settings');
  if (!key.trim()) throw new SenderError('setting key is empty');
  const s = ctx.db.setting.key.find(key);
  if (s) ctx.db.setting.key.update({ key, value });
  else ctx.db.setting.insert({ key, value });
});
