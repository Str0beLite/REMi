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
  return { h, call, user, id };
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

describe('set_node_join_code', () => {
  it('is admin-only, validates, keeps one private code and mirrors node_joining', () => {
    const w = setup();
    const joining = () => w.h.db.setting.key.find('node_joining')?.value;
    expect(() => w.call('bob', mod.set_node_join_code, { code: CODE })).toThrow(/only an admin/);
    expect(() => w.call('owner', mod.set_node_join_code, { code: 'short' })).toThrow(/16-64 characters/);
    w.call('owner', mod.set_node_join_code, { code: CODE });
    expect(joining()).toBe('on');
    w.call('owner', mod.set_node_join_code, { code: 'other_Abc-0123456789xyz' });
    expect([...w.h.db.node_join_code.iter()].map(r => r.code)).toEqual(['other_Abc-0123456789xyz']);
    w.call('owner', mod.set_node_join_code, { code: '' });
    expect([...w.h.db.node_join_code.iter()]).toHaveLength(0);
    expect(joining()).toBe('');
  });
});

describe('remove_user', () => {
  it('deletes the user and their memberships, keeps their messages', () => {
    const w = setup();
    const general = [...w.h.db.channel.iter()].find(c => c.name === 'general')!.id;
    const bob = w.id.bob.toHexString();
    w.call('bob', mod.join, { channel_id: general, member_kind: 'user', member_id: bob });
    w.call('carol', mod.join, { channel_id: general, member_kind: 'user', member_id: w.id.carol.toHexString() });
    w.call('bob', mod.post_message, { channel_id: general, author_kind: 'user', author_id: bob, kind: 'chat', body: 'hi', meta: '{}' });
    w.call('owner', mod.remove_user, { identity: w.id.bob });
    expect(w.user('bob')).toBeNull();
    expect([...w.h.db.member.iter()].map(m => m.member_id)).toEqual([w.id.carol.toHexString()]);
    expect([...w.h.db.message.iter()].filter(m => m.author_id === bob)).toHaveLength(1);
    // Not a ban: the same identity can join again, as a new non-admin user.
    w.call('bob', mod.set_nickname, { nickname: 'bob2' });
    expect(w.user('bob')).toMatchObject({ nickname: 'bob2', is_admin: false });
  });

  it('refuses non-admins, unknown users, yourself and the owner, even renamed', () => {
    const w = setup();
    expect(() => w.call('carol', mod.remove_user, { identity: w.id.bob })).toThrow(/only an admin/);
    expect(() => w.call('owner', mod.remove_user, { identity: w.id.dave })).toThrow(/no such user/);
    expect(() => w.call('owner', mod.remove_user, { identity: w.id.owner })).toThrow(/yourself/);
    w.call('owner', mod.set_nickname, { nickname: 'ryan' });
    w.call('owner', mod.set_user_admin, { identity: w.id.bob, is_admin: true });
    expect(() => w.call('bob', mod.remove_user, { identity: w.id.owner })).toThrow(/workspace owner/);
    expect(w.user('owner')).toBeTruthy();
  });
});

describe('set_user_admin', () => {
  it('grants and revokes, never on yourself or the owner', () => {
    const w = setup();
    expect(() => w.call('bob', mod.set_user_admin, { identity: w.id.bob, is_admin: true })).toThrow(/only an admin/);
    expect(() => w.call('owner', mod.set_user_admin, { identity: w.id.dave, is_admin: true })).toThrow(/no such user/);
    w.call('owner', mod.set_user_admin, { identity: w.id.bob, is_admin: true });
    expect(w.user('bob')?.is_admin).toBe(true);
    expect(() => w.call('bob', mod.set_user_admin, { identity: w.id.owner, is_admin: false })).toThrow(/workspace owner/);
    expect(() => w.call('owner', mod.set_user_admin, { identity: w.id.owner, is_admin: false })).toThrow(/yourself/);
    w.call('bob', mod.set_user_admin, { identity: w.id.carol, is_admin: true });
    w.call('carol', mod.set_user_admin, { identity: w.id.bob, is_admin: false });
    expect(w.user('bob')?.is_admin).toBe(false);
    expect(w.user('owner')?.is_admin).toBe(true);
  });
});
