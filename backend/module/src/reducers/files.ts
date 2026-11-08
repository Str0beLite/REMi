// Looking into an agent's sandbox from the console (#98): CONTRACT.md §4 fs_ask, fs_answer.
// The console asks, the agent's node answers in `result` (§8 "Browsing a REMi's files").
import { SenderError, t } from 'spacetimedb/server';
import db, { FS_OPS } from '../contract';

const KEEP_MICROS = 10n * 60n * 1_000_000n;
const MAX_RESULT = 1_500_000;

// Absolute, inside /workspace or /shared, no `..` segment. The node also resolves symlinks inside the sandbox.
function badPath(path: string): string | undefined {
  if (path.length > 1024 || path.includes('\0')) return 'paths are at most 1024 characters';
  if (!/^\/(workspace|shared)(\/|$)/.test(path)) return 'paths start /workspace or /shared';
  if (path.split('/').includes('..')) return 'paths may not contain ..';
}

export const fs_ask = db.reducer({ agent_id: t.u64(), op: t.string(), path: t.string() }, (ctx, { agent_id, op, path }) => {
  const a = ctx.db.agent.id.find(agent_id);
  if (!a) throw new SenderError(`no agent ${agent_id}`);
  if (!a.owner.equals(ctx.sender) && ctx.db.user.identity.find(ctx.sender)?.is_admin !== true)
    throw new SenderError("only the agent's owner or an admin can look at its files");
  if (!(FS_OPS as readonly string[]).includes(op)) throw new SenderError(`op is one of ${FS_OPS.join(', ')}`);
  const bad = badPath(path);
  if (bad) throw new SenderError(bad);
  const cutoff = ctx.timestamp.microsSinceUnixEpoch - KEEP_MICROS;
  for (const r of [...ctx.db.fs_request.iter()]) if (r.ts.microsSinceUnixEpoch < cutoff) ctx.db.fs_request.id.delete(r.id);
  ctx.db.fs_request.insert({ id: 0n, agent_id, requested_by: ctx.sender, op, path, state: 'pending', result: '', ts: ctx.timestamp });
});

export const fs_answer = db.reducer({ id: t.u64(), ok: t.bool(), result: t.string() }, (ctx, { id, ok, result }) => {
  const r = ctx.db.fs_request.id.find(id);
  if (!r) throw new SenderError(`no fs_request ${id}`);
  const a = ctx.db.agent.id.find(r.agent_id);
  if (!a || ctx.db.node.identity.find(ctx.sender)?.id !== a.node_id) throw new SenderError("only the agent's node can answer");
  if (r.state !== 'pending') throw new SenderError(`fs_request ${id} is ${r.state}`);
  if (result.length > MAX_RESULT) throw new SenderError(`results are at most ${MAX_RESULT} characters`);
  ctx.db.fs_request.id.update({ ...r, state: ok ? 'done' : 'failed', result });
});
