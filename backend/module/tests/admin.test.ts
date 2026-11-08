import { ConnectionId, Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import db from '../src/contract';

let conn = 1n;
const auth = (sub: string) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(conn++));
const CODE = 'claim_Abc-0123456789xyz';

// The publisher runs init; bob and carol are plain users, dave has no user row yet.
function setup() {
  const h = createModuleTestHarness(db, mod);
  const as = { owner: auth('owner'), bob: auth('bob'), carol: auth('carol'), dave: auth('dave') };
  const id = Object.fromEntries(Object.entries(as).map(([k, a]) => [k, h.withReducerTx(a, ctx => ctx.sender)])) as Record<keyof typeof as, Identity>;
  h.withReducerTx(as.owner, ctx => mod.init(ctx as never, {}));
  for (const who of ['bob', 'carol'] as const) h.withReducerTx(as[who], ctx => mod.set_nickname(ctx as never, { nickname: who }));
  const call = <A>(who: keyof typeof as, fn: (ctx: never, args: A) => void, args: A) => h.withReducerTx(as[who], ctx => fn(ctx as never, args));
  const user = (who: keyof typeof as) => h.db.user.identity.find(id[who]);
  return { h, call, user };
}

describe('init', () => {
  it('makes the publisher an admin user named owner', () => {
    const w = setup();
    expect(w.user('owner')).toMatchObject({ nickname: 'owner', is_admin: true });
    expect(w.user('bob')?.is_admin).toBe(false);
  });
});

describe('add_admin_code', () => {
  it('is admin-only and validates the code', () => {
    const w = setup();
    expect(() => w.call('bob', mod.add_admin_code, { code: CODE })).toThrow(/only an admin/);
    expect(() => w.call('owner', mod.add_admin_code, { code: 'short' })).toThrow(/16-64 characters/);
    expect(() => w.call('owner', mod.add_admin_code, { code: 'has spaces in it, too long ok' })).toThrow(/16-64 characters/);
    expect(() => w.call('owner', mod.add_admin_code, { code: 'x'.repeat(65) })).toThrow(/16-64 characters/);
    w.call('owner', mod.add_admin_code, { code: CODE });
    expect(w.h.db.admin_code.code.find(CODE)).toBeTruthy();
    expect(() => w.call('owner', mod.add_admin_code, { code: CODE })).toThrow(/already exists/);
  });
});

describe('claim_admin', () => {
  it('makes the caller admin and is single use', () => {
    const w = setup();
    w.call('owner', mod.add_admin_code, { code: CODE });
    w.call('bob', mod.claim_admin, { code: CODE });
    expect(w.user('bob')?.is_admin).toBe(true);
    expect(w.h.db.admin_code.code.find(CODE)).toBeNull();
    expect(() => w.call('carol', mod.claim_admin, { code: CODE })).toThrow(/already used or is not valid/);
    expect(w.user('carol')?.is_admin).toBe(false);
  });

  it('needs a user row, and an existing code', () => {
    const w = setup();
    w.call('owner', mod.add_admin_code, { code: CODE });
    expect(() => w.call('dave', mod.claim_admin, { code: CODE })).toThrow(/set a nickname first/);
    expect(w.h.db.admin_code.code.find(CODE)).toBeTruthy();
    expect(() => w.call('bob', mod.claim_admin, { code: 'nope_nope_nope_nope' })).toThrow(/already used or is not valid/);
  });
});
