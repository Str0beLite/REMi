// CONTRACT.md §4 request_sleep: the console's "Sleep now" button. Posts the same night event the scheduler
// does, so Sleep REMi wakes exactly as it would at sleep_cron.
import { SenderError } from 'spacetimedb/server';
import db from '../contract';

export const request_sleep = db.reducer(ctx => {
  const me = ctx.db.user.identity.find(ctx.sender);
  if (!me?.is_admin) throw new SenderError('only an admin can start sleep');
  const ops = [...ctx.db.channel.iter()].find(c => c.kind === 'public' && c.name === 'ops');
  if (!ops) throw new SenderError('no #ops channel');
  ctx.db.message.insert({
    id: 0n,
    channel_id: ops.id,
    author_kind: 'system',
    author_id: 'system',
    kind: 'sleep_event',
    body: `Sleep now requested by ${me.nickname}`,
    meta: JSON.stringify({ phase: 'night' }),
    ts: ctx.timestamp,
  });
});
