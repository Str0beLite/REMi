// Admin bootstrap and machine joining: CONTRACT.md §4 add_admin_code, claim_admin, set_node_join_code. `remi up` adds a one-time code and prints a console
// link carrying it; whoever opens the link claims admin. Codes live in the private admin_code table.
import type { Identity } from 'spacetimedb';
import { SenderError, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import db from '../contract';

type Ctx = ReducerCtx<InferSchema<typeof db>>;

const CODE = /^[A-Za-z0-9_-]{16,64}$/;

export const add_admin_code = db.reducer({ code: t.string() }, (ctx, { code }) => {
  if (ctx.db.user.identity.find(ctx.sender)?.is_admin !== true) throw new SenderError('only an admin can add admin codes');
  if (!CODE.test(code)) throw new SenderError('admin codes are 16-64 characters of A-Z, a-z, 0-9, _ and -');
  if (ctx.db.admin_code.code.find(code)) throw new SenderError('that admin code already exists');
  ctx.db.admin_code.insert({ code });
});

export const claim_admin = db.reducer({ code: t.string() }, (ctx, { code }) => {
  const me = ctx.db.user.identity.find(ctx.sender);
  if (!me) throw new SenderError('set a nickname first');
  if (!ctx.db.admin_code.code.find(code)) throw new SenderError('this admin link was already used or is not valid');
  ctx.db.admin_code.code.delete(code);
  ctx.db.user.identity.update({ ...me, is_admin: true });
});

// One join code at a time (#84): a new code revokes the old one, '' turns joining off. `node_joining` lets the
// console show the state, since the code itself is private.
export const set_node_join_code = db.reducer({ code: t.string() }, (ctx, { code }) => {
  if (ctx.db.user.identity.find(ctx.sender)?.is_admin !== true) throw new SenderError('only an admin can change the join code');
  if (code !== '' && !CODE.test(code)) throw new SenderError('join codes are 16-64 characters of A-Z, a-z, 0-9, _ and -');
  for (const row of [...ctx.db.node_join_code.iter()]) ctx.db.node_join_code.code.delete(row.code);
  if (code) ctx.db.node_join_code.insert({ code });
  const value = code ? 'on' : '';
  if (ctx.db.setting.key.find('node_joining')) ctx.db.setting.key.update({ key: 'node_joining', value });
  else ctx.db.setting.insert({ key: 'node_joining', value });
});

// People (#95). The workspace owner is whoever published it: init creates #general as them. Nicknames change, this doesn't.
const isOwner = (ctx: Ctx, id: Identity) =>
  [...ctx.db.channel.iter()].some(c => c.name === 'general' && c.kind === 'public' && c.parent_id === 0n && c.created_by.equals(id));

const adminOnly = (ctx: Ctx) => {
  if (ctx.db.user.identity.find(ctx.sender)?.is_admin !== true) throw new SenderError('only an admin can manage people');
};

const userOf = (ctx: Ctx, identity: Identity) => {
  const u = ctx.db.user.identity.find(identity);
  if (!u) throw new SenderError('no such user');
  return u;
};

// Shared by remove_user and set_user_admin(false). The caller is an admin and never the target, so an admin always remains.
const notSelfOrOwner = (ctx: Ctx, identity: Identity) => {
  if (identity.equals(ctx.sender)) throw new SenderError("you can't do this to yourself");
  if (isOwner(ctx, identity)) throw new SenderError("the workspace owner can't be removed or demoted");
};

// Deletes the person and their channel memberships; their messages and agents stay (CONTRACT.md §4 remove_user).
export const remove_user = db.reducer({ identity: t.identity() }, (ctx, { identity }) => {
  adminOnly(ctx);
  userOf(ctx, identity);
  notSelfOrOwner(ctx, identity);
  const hex = identity.toHexString();
  for (const m of [...ctx.db.member.iter()]) if (m.member_kind === 'user' && m.member_id === hex) ctx.db.member.id.delete(m.id);
  ctx.db.user.identity.delete(identity);
});

export const set_user_admin = db.reducer({ identity: t.identity(), is_admin: t.bool() }, (ctx, { identity, is_admin }) => {
  adminOnly(ctx);
  const u = userOf(ctx, identity);
  if (!is_admin) notSelfOrOwner(ctx, identity);
  ctx.db.user.identity.update({ ...u, is_admin });
});
