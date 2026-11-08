import { ConnectionId, Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import db from '../src/contract';

let conn = 1n;
const auth = (sub: string) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(conn++));

function setup() {
  const h = createModuleTestHarness(db, mod);
  const as = { admin: auth('admin'), bob: auth('bob') };
  const id = Object.fromEntries(Object.entries(as).map(([k, a]) => [k, h.withReducerTx(a, ctx => ctx.sender)])) as Record<keyof typeof as, Identity>;
  h.withReducerTx(TestAuth.internal(), ctx => {
    mod.init(ctx, {});
    ctx.db.user.insert({ identity: id.admin, nickname: 'ryan', is_admin: true });
    ctx.db.user.insert({ identity: id.bob, nickname: 'bob', is_admin: false });
  });
  return { h, call: (who: keyof typeof as) => h.withReducerTx(as[who], ctx => mod.request_sleep(ctx as never, {})) };
}

describe('request_sleep', () => {
  it('posts a system sleep_event with phase night in #ops', () => {
    const w = setup();
    w.call('admin');
    const [m] = [...w.h.db.message.iter()];
    const ops = [...w.h.db.channel.iter()].find(c => c.name === 'ops')!;
    expect(m).toMatchObject({
      channel_id: ops.id,
      author_kind: 'system',
      kind: 'sleep_event',
      body: 'Sleep now requested by ryan',
      meta: '{"phase":"night"}',
    });
  });

  it('refuses non-admins', () => {
    const w = setup();
    expect(() => w.call('bob')).toThrow(/only an admin/);
    expect(w.h.db.message.count()).toBe(0n);
  });
});
