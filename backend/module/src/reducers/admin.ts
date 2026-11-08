// Admin bootstrap: CONTRACT.md §4 add_admin_code, claim_admin. `remi up` adds a one-time code and prints a console
// link carrying it; whoever opens the link claims admin. Codes live in the private admin_code table.
import { SenderError, t } from 'spacetimedb/server';
import db from '../contract';

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
