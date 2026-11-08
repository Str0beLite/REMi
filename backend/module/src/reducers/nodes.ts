// Moving REMis between nodes (#76), sending files between agents (#77) and starting/stopping REMis (#79):
// CONTRACT.md §4 move_agent, put_blob_chunk, migration_ready, finish_migration, fail_migration, send_file,
// file_delivered, file_failed, start_agent, control_agent. Bytes travel base64 in blob_chunk.
import { SenderError, t } from 'spacetimedb/server';
import db from '../contract';
import { parseAgentfile } from '../agentfile';
import { logHistory, type Ctx } from '../agentOps';

type AgentRow = NonNullable<ReturnType<Ctx['db']['agent']['id']['find']>>;

const MAX_CHUNK = 262_144;
const MAX_FILE = 52_428_800;
const FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

const callerNode = (ctx: Ctx) => ctx.db.node.identity.find(ctx.sender);
const callerUser = (ctx: Ctx) => ctx.db.user.identity.find(ctx.sender);
const isAdmin = (ctx: Ctx) => callerUser(ctx)?.is_admin === true;

function agentOrThrow(ctx: Ctx, id: bigint) {
  const a = ctx.db.agent.id.find(id);
  if (!a) throw new SenderError(`no agent ${id}`);
  return a;
}

function isCallerNodeOf(ctx: Ctx, nodeId: bigint) {
  return callerNode(ctx)?.id === nodeId;
}

// An agent acting through its own node, with `tool` in its Agentfile.
function actingAgent(ctx: Ctx, byAgent: bigint, tool: string) {
  const by = agentOrThrow(ctx, byAgent);
  if (!isCallerNodeOf(ctx, by.node_id)) throw new SenderError(`only ${by.name}'s node can act for it`);
  if (!parseAgentfile(by.agentfile).tools.includes(tool)) throw new SenderError(`${by.name} doesn't have the ${tool} tool`);
  return by;
}

function post(ctx: Ctx, channelId: bigint, body: string) {
  ctx.db.message.insert({ id: 0n, channel_id: channelId, author_kind: 'system', author_id: 'system', kind: 'chat', body, meta: '{}', ts: ctx.timestamp });
}

function postOps(ctx: Ctx, body: string) {
  const ops = [...ctx.db.channel.iter()].find(c => c.kind === 'public' && c.name === 'ops');
  if (ops) post(ctx, ops.id, body);
}

function deleteBlobs(ctx: Ctx, prefix: string) {
  for (const c of [...ctx.db.blob_chunk.iter()]) if (c.blob.startsWith(prefix)) ctx.db.blob_chunk.id.delete(c.id);
}

const hasFiles = (ctx: Ctx, key: string, nodeId: bigint) =>
  ctx.db.adapter.key.find(key)?.node_id === nodeId || [...ctx.db.adapter_copy.key.filter(key)].some(c => c.node_id === nodeId);

function size(n: bigint) {
  const b = Number(n);
  return b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
}

function stop(ctx: Ctx, a: AgentRow) {
  ctx.db.agent.id.update({ ...a, status: 'stopped' });
  for (const r of ctx.db.run.agent_id.filter(a.id)) if (r.state === 'running') ctx.db.run.id.update({ ...r, state: 'stopped' });
}

// -- moving an agent ------------------------------------------------------------------------------------------------

export const move_agent = db.reducer(
  { agent_id: t.u64(), node_id: t.u64(), by_agent: t.u64() },
  (ctx, { agent_id, node_id, by_agent }) => {
    const a = agentOrThrow(ctx, agent_id);
    let who: string;
    if (by_agent === 0n) {
      const u = callerUser(ctx);
      if (a.protected ? !isAdmin(ctx) : !(a.owner.equals(ctx.sender) || isAdmin(ctx)))
        throw new SenderError(a.protected ? 'only an admin can move a protected agent' : 'only the owner or an admin can move this agent');
      who = u?.nickname ?? 'someone';
    } else {
      const by = actingAgent(ctx, by_agent, 'migrate');
      if (a.protected) throw new SenderError(`${a.name} is protected; only an admin can move it`);
      who = by.name;
    }
    if (a.status === 'moving') throw new SenderError(`${a.name} is already moving`);
    if (a.status === 'thinking' && a.id !== by_agent) throw new SenderError(`${a.name} is busy; try when it's idle`);
    if (a.node_id === node_id) throw new SenderError(`${a.name} is already on that node`);
    const from = ctx.db.node.id.find(a.node_id);
    const to = ctx.db.node.id.find(node_id);
    if (!to) throw new SenderError(`no node ${node_id}`);
    if (to.status !== 'up') throw new SenderError(`node ${to.name} is ${to.status}`);
    if (from && from.base_model !== to.base_model)
      throw new SenderError(`node ${to.name} runs ${to.base_model}, not ${from.base_model}; LoRAs only work on their own base`);
    ctx.db.agent.id.update({ ...a, status: 'moving' });
    ctx.db.migration.insert({ id: 0n, agent_id, from_node: a.node_id, to_node: node_id, state: 'uploading', note: '', ts: ctx.timestamp });
    postOps(ctx, `${who} is moving ${a.name} from ${from?.name ?? '?'} to ${to.name}`);
  },
);

export const put_blob_chunk = db.reducer({ blob: t.string(), seq: t.u32(), data: t.string() }, (ctx, { blob, seq, data }) => {
  if (!callerNode(ctx)) throw new SenderError('only a node can upload');
  if (blob.length > 200 || !/^(mig|file):/.test(blob)) throw new SenderError('blob names start mig: or file: (at most 200 characters)');
  if (data.length > MAX_CHUNK) throw new SenderError(`chunks are at most ${MAX_CHUNK} characters`);
  if (blob.startsWith('mig:')) {
    const m = ctx.db.migration.id.find(BigInt(blob.split(':')[1] || '0'));
    if (!m || !isCallerNodeOf(ctx, m.from_node) || m.state !== 'uploading') throw new SenderError('not an upload for a migration from this node');
  }
  for (const c of ctx.db.blob_chunk.blob.filter(blob)) if (c.seq === seq) ctx.db.blob_chunk.id.delete(c.id);
  ctx.db.blob_chunk.insert({ id: 0n, blob, seq, data });
});

function migrationOrThrow(ctx: Ctx, id: bigint) {
  const m = ctx.db.migration.id.find(id);
  if (!m) throw new SenderError(`no migration ${id}`);
  return m;
}

export const migration_ready = db.reducer({ id: t.u64() }, (ctx, { id }) => {
  const m = migrationOrThrow(ctx, id);
  if (!isCallerNodeOf(ctx, m.from_node)) throw new SenderError('only the node it moves from can mark it ready');
  if (m.state !== 'uploading') throw new SenderError(`migration ${id} is ${m.state}`);
  ctx.db.migration.id.update({ ...m, state: 'ready' });
});

export const finish_migration = db.reducer({ id: t.u64() }, (ctx, { id }) => {
  const m = migrationOrThrow(ctx, id);
  if (!isCallerNodeOf(ctx, m.to_node)) throw new SenderError('only the node it moves to can finish it');
  if (m.state !== 'ready') throw new SenderError(`migration ${id} is ${m.state}`);
  const a = agentOrThrow(ctx, m.agent_id);
  for (const ad of parseAgentfile(a.agentfile).adapters) {
    const key = `${ad.name}@${ad.version}`;
    if (!hasFiles(ctx, key, m.to_node)) ctx.db.adapter_copy.insert({ id: 0n, key, node_id: m.to_node });
  }
  ctx.db.agent.id.update({ ...a, node_id: m.to_node, status: 'idle' });
  ctx.db.migration.id.update({ ...m, state: 'done' });
  deleteBlobs(ctx, `mig:${id}:`);
  logHistory(ctx, a.id, a.agentfile);
  postOps(ctx, `${a.name} moved to ${ctx.db.node.id.find(m.to_node)?.name ?? m.to_node}`);
});

export const fail_migration = db.reducer({ id: t.u64(), note: t.string() }, (ctx, { id, note }) => {
  const m = migrationOrThrow(ctx, id);
  if (!isCallerNodeOf(ctx, m.from_node) && !isCallerNodeOf(ctx, m.to_node) && !isAdmin(ctx))
    throw new SenderError('only its nodes or an admin can fail a migration');
  if (m.state !== 'uploading' && m.state !== 'ready') throw new SenderError(`migration ${id} is ${m.state}`);
  ctx.db.migration.id.update({ ...m, state: 'failed', note: note.slice(0, 500) });
  const a = ctx.db.agent.id.find(m.agent_id);
  if (a && a.status === 'moving') ctx.db.agent.id.update({ ...a, status: 'idle' });
  deleteBlobs(ctx, `mig:${id}:`);
  postOps(ctx, `Moving ${a?.name ?? m.agent_id} failed: ${note.slice(0, 500)}`);
});

// -- sending a file ---------------------------------------------------------------------------------------------------

export const send_file = db.reducer(
  {
    blob: t.string(), name: t.string(), size: t.u64(), sha256: t.string(), chunks: t.u32(),
    from_agent: t.u64(), to_agent: t.u64(), channel_id: t.u64(), note: t.string(),
  },
  (ctx, { blob, name, size: bytes, sha256, chunks, from_agent, to_agent, channel_id, note }) => {
    const from = agentOrThrow(ctx, from_agent);
    if (!isCallerNodeOf(ctx, from.node_id)) throw new SenderError(`only ${from.name}'s node can send for it`);
    const to = agentOrThrow(ctx, to_agent);
    if (to.id === from.id) throw new SenderError("you can't send a file to yourself");
    if (!blob.startsWith('file:')) throw new SenderError('file blobs start file:');
    if (!FILE_NAME.test(name)) throw new SenderError('file names are 1-128 characters of A-Z, a-z, 0-9, ., _ and -');
    if (bytes > BigInt(MAX_FILE)) throw new SenderError('files are at most 50 MB');
    if (!ctx.db.channel.id.find(channel_id)) throw new SenderError(`no channel ${channel_id}`);
    const seqs = new Set([...ctx.db.blob_chunk.blob.filter(blob)].map(c => c.seq));
    for (let i = 0; i < chunks; i++) if (!seqs.has(i)) throw new SenderError(`chunk ${i} of ${blob} is missing`);
    ctx.db.file_transfer.insert({
      id: 0n, blob, name, size: bytes, sha256, chunks, from_agent, to_agent, channel_id, note: note.slice(0, 500), state: 'sent', ts: ctx.timestamp,
    });
  },
);

function transferForRecipientNode(ctx: Ctx, id: bigint, allowAdmin: boolean) {
  const f = ctx.db.file_transfer.id.find(id);
  if (!f) throw new SenderError(`no file transfer ${id}`);
  const to = ctx.db.agent.id.find(f.to_agent);
  if (!(to && isCallerNodeOf(ctx, to.node_id)) && !(allowAdmin && isAdmin(ctx)))
    throw new SenderError("only the recipient's node can do this");
  if (f.state !== 'sent') throw new SenderError(`file transfer ${id} is ${f.state}`);
  return { f, to };
}

const nameOf = (ctx: Ctx, id: bigint) => ctx.db.agent.id.find(id)?.name ?? `agent ${id}`;

export const file_delivered = db.reducer({ id: t.u64() }, (ctx, { id }) => {
  const { f } = transferForRecipientNode(ctx, id, false);
  ctx.db.file_transfer.id.update({ ...f, state: 'delivered' });
  deleteBlobs(ctx, f.blob);
  post(ctx, f.channel_id, `@${nameOf(ctx, f.to_agent)} ${nameOf(ctx, f.from_agent)} sent you /shared/${f.name} (${size(f.size)})${f.note ? ` — ${f.note}` : ''}`);
});

export const file_failed = db.reducer({ id: t.u64(), note: t.string() }, (ctx, { id, note }) => {
  const { f } = transferForRecipientNode(ctx, id, true);
  ctx.db.file_transfer.id.update({ ...f, state: 'failed', note: note.slice(0, 500) });
  deleteBlobs(ctx, f.blob);
  post(ctx, f.channel_id, `@${nameOf(ctx, f.from_agent)} sending ${f.name} to ${nameOf(ctx, f.to_agent)} failed: ${note.slice(0, 500)}`);
});

// -- starting and stopping ---------------------------------------------------------------------------------------------

function start(ctx: Ctx, a: AgentRow) {
  if (a.status !== 'stopped') throw new SenderError(`${a.name} is ${a.status}, not stopped`);
  ctx.db.agent.id.update({ ...a, status: 'idle' });
}

export const start_agent = db.reducer({ agent_id: t.u64() }, (ctx, { agent_id }) => {
  const a = agentOrThrow(ctx, agent_id);
  if (!a.owner.equals(ctx.sender) && !isAdmin(ctx)) throw new SenderError('only the owner or an admin can start this agent');
  start(ctx, a);
});

export const control_agent = db.reducer({ agent_id: t.u64(), action: t.string(), by_agent: t.u64() }, (ctx, { agent_id, action, by_agent }) => {
  const by = actingAgent(ctx, by_agent, 'agents');
  const a = agentOrThrow(ctx, agent_id);
  if (a.protected) throw new SenderError(`${a.name} is protected; only an admin can stop or start it`);
  if (action === 'stop') stop(ctx, a);
  else if (action === 'start') start(ctx, a);
  else throw new SenderError('action is stop or start');
  postOps(ctx, `${by.name} ${action === 'stop' ? 'stopped' : 'started'} ${a.name}`);
});
