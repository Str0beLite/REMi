import { ConnectionId, Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import db from '../src/contract';

let conn = 1n;
const auth = (sub: string) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(conn++));

// World: admin user, plain user bob, a stranger with no rows, node A running agent 1, node B.
function setup() {
  const h = createModuleTestHarness(db, mod);
  const sys = TestAuth.internal();
  const as = { admin: auth('admin'), bob: auth('bob'), stranger: auth('stranger'), nodeA: auth('node-a'), nodeB: auth('node-b') };
  const id = Object.fromEntries(Object.entries(as).map(([k, a]) => [k, h.withReducerTx(a, ctx => ctx.sender)])) as Record<keyof typeof as, Identity>;
  h.withReducerTx(sys, ctx => {
    mod.init(ctx, {});
    ctx.db.user.insert({ identity: id.admin, nickname: 'ryan', is_admin: true });
    ctx.db.user.insert({ identity: id.bob, nickname: 'bob', is_admin: false });
    const node = (identity: Identity, name: string) =>
      ctx.db.node.insert({ id: 0n, identity, name, gpu: 'x', base_model: 'm', status: 'up', last_seen: ctx.timestamp, stats: '{}' });
    const a = node(id.nodeA, 'node-a');
    node(id.nodeB, 'node-b');
    ctx.db.agent.insert({ id: 0n, name: 'oncall', agentfile: '', status: 'idle', node_id: a.id, owner: id.admin, protected: false });
  });
  const general = [...h.db.channel.iter()].find(c => c.name === 'general')!.id;
  const hex = (k: keyof typeof as) => id[k].toHexString();
  const call = <A>(who: keyof typeof as, fn: (ctx: never, args: A) => void, args: A) =>
    h.withReducerTx(as[who], ctx => fn(ctx as never, args));
  return { h, general, hex, call };
}

const msg = (channel_id: bigint, over: Partial<Record<string, string>> = {}) => ({
  channel_id,
  author_kind: 'agent',
  author_id: '1',
  kind: 'chat',
  body: 'hi',
  meta: '{}',
  ...over,
});

describe('set_nickname', () => {
  it('creates a user, then updates it without touching is_admin', () => {
    const w = setup();
    w.call('stranger', mod.set_nickname, { nickname: 'sam' });
    expect([...w.h.db.user.iter()].find(u => u.nickname === 'sam')?.is_admin).toBe(false);
    w.call('admin', mod.set_nickname, { nickname: 'ryan2' });
    expect([...w.h.db.user.iter()].find(u => u.nickname === 'ryan2')?.is_admin).toBe(true);
  });
  it('rejects empty and over-24-character names', () => {
    const w = setup();
    expect(() => w.call('bob', mod.set_nickname, { nickname: '  ' })).toThrow(/1-24/);
    expect(() => w.call('bob', mod.set_nickname, { nickname: 'x'.repeat(25) })).toThrow(/1-24/);
  });
});

describe('create_channel', () => {
  it('lets users and nodes create public, thread and dm channels', () => {
    const w = setup();
    w.call('bob', mod.create_channel, { name: 'capacity', kind: 'public', parent_id: 0n });
    w.call('nodeA', mod.create_channel, { name: 'PDU question', kind: 'thread', parent_id: w.general });
    w.call('bob', mod.create_channel, { name: 'dm-abc-1', kind: 'dm', parent_id: 0n });
    expect([...w.h.db.channel.iter()].map(c => c.kind).sort()).toEqual(['dm', 'public', 'public', 'public', 'thread']);
  });
  it('rejects callers that are neither user nor node', () => {
    const w = setup();
    expect(() => w.call('stranger', mod.create_channel, { name: 'x', kind: 'public', parent_id: 0n })).toThrow(/nickname/);
  });
  it('rejects bad kinds, names, duplicates and missing parents', () => {
    const w = setup();
    const c = (name: string, kind: string, parent_id = 0n) => () => w.call('bob', mod.create_channel, { name, kind, parent_id });
    expect(c('x', 'voice')).toThrow(/unknown channel kind/);
    expect(c('Capacity', 'public')).toThrow(/lowercase/);
    expect(c('general', 'public')).toThrow(/already exists/);
    expect(c('t', 'thread', 999n)).toThrow(/no channel/);
    expect(c('chat-with-bob', 'dm')).toThrow(/dm-<a>-<b>/);
  });
});

describe('join and leave', () => {
  it('lets a user join and leave as themselves, idempotently', () => {
    const w = setup();
    const args = { channel_id: w.general, member_kind: 'user', member_id: w.hex('bob') };
    w.call('bob', mod.join, args);
    w.call('bob', mod.join, args);
    expect(w.h.db.member.count()).toBe(1n);
    w.call('bob', mod.leave, args);
    expect(w.h.db.member.count()).toBe(0n);
  });
  it('lets the agent node and an admin manage an agent; other nodes and users cannot', () => {
    const w = setup();
    const args = { channel_id: w.general, member_kind: 'agent', member_id: '1' };
    w.call('nodeA', mod.join, args);
    expect(() => w.call('nodeB', mod.leave, args)).toThrow(/not allowed/);
    expect(() => w.call('bob', mod.leave, args)).toThrow(/not allowed/);
    w.call('admin', mod.leave, args);
    expect(w.h.db.member.count()).toBe(0n);
  });
  it('rejects joining someone else, unknown members, kinds and channels', () => {
    const w = setup();
    expect(() => w.call('bob', mod.join, { channel_id: w.general, member_kind: 'user', member_id: w.hex('admin') })).toThrow(/not allowed/);
    expect(() => w.call('admin', mod.join, { channel_id: w.general, member_kind: 'agent', member_id: '42' })).toThrow(/no agent/);
    expect(() => w.call('bob', mod.join, { channel_id: w.general, member_kind: 'bot', member_id: '1' })).toThrow(/member kind/);
    expect(() => w.call('bob', mod.join, { channel_id: 999n, member_kind: 'user', member_id: w.hex('bob') })).toThrow(/no channel/);
    expect(() => w.call('bob', mod.leave, { channel_id: w.general, member_kind: 'user', member_id: w.hex('bob') })).toThrow(/not a member/);
  });
});

describe('post_message', () => {
  it('lets a user post chat as themselves', () => {
    const w = setup();
    w.call('bob', mod.post_message, msg(w.general, { author_kind: 'user', author_id: w.hex('bob') }));
    expect(w.h.db.message.count()).toBe(1n);
  });
  it('rejects users posting as others, as agents or non-chat kinds', () => {
    const w = setup();
    const p = (over: Partial<Record<string, string>>) => () => w.call('bob', mod.post_message, msg(w.general, over));
    expect(p({ author_kind: 'user', author_id: w.hex('admin') })).toThrow(/themselves/);
    expect(p({ author_kind: 'user', author_id: w.hex('bob'), kind: 'tool_card' })).toThrow(/only chat/);
    expect(p({ author_kind: 'agent', author_id: '1' })).toThrow(/only nodes/);
  });
  it('lets a node post as its agent or system with any kind', () => {
    const w = setup();
    w.call('nodeA', mod.post_message, msg(w.general, { kind: 'tool_call', meta: '{"run_id":1,"command":"sh"}' }));
    w.call('nodeB', mod.post_message, msg(w.general, { author_kind: 'system', author_id: '', kind: 'sleep_event', meta: '{"phase":"night"}' }));
    expect(w.h.db.message.count()).toBe(2n);
  });
  it("rejects a node posting as another node's agent", () => {
    const w = setup();
    expect(() => w.call('nodeB', mod.post_message, msg(w.general))).toThrow(/does not run on this node/);
  });
  it('rejects bad meta, unknown kinds, long bodies and missing channels', () => {
    const w = setup();
    const p = (over: Partial<Record<string, string>>, ch = w.general) => () => w.call('nodeA', mod.post_message, msg(ch, over));
    expect(p({ meta: '{not json' })).toThrow(/valid JSON/);
    expect(p({ meta: '[1]' })).toThrow(/JSON object/);
    expect(p({ kind: 'shout' })).toThrow(/unknown message kind/);
    expect(p({ author_kind: 'robot' })).toThrow(/unknown author kind/);
    expect(p({ body: 'x'.repeat(16_001) })).toThrow(/16000/);
    expect(p({}, 999n)).toThrow(/no channel/);
  });
});

describe('clear_channel', () => {
  it("deletes the channel's and its threads' messages, keeps channels, members, runs and other channels", () => {
    const w = setup();
    const ops = [...w.h.db.channel.iter()].find(c => c.name === 'ops')!.id;
    w.call('nodeA', mod.create_channel, { name: 'side', kind: 'thread', parent_id: w.general });
    const thread = [...w.h.db.channel.iter()].find(c => c.kind === 'thread')!.id;
    w.call('nodeA', mod.join, { channel_id: w.general, member_kind: 'agent', member_id: '1' });
    for (const ch of [w.general, thread, ops]) w.call('nodeA', mod.post_message, msg(ch));
    w.call('nodeA', mod.run_start, { agent_id: 1n, channel_id: w.general, trigger_msg_id: 1n });
    w.call('admin', mod.clear_channel, { channel_id: w.general });
    const left = [...w.h.db.message.iter()].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(left.map(m => [m.channel_id, m.author_kind, m.kind, m.body])).toEqual([
      [ops, 'agent', 'chat', 'hi'],
      [w.general, 'system', 'system', 'ryan cleared this channel'],
    ]);
    expect(left[1].id).toBeGreaterThan(3n); // ids are never reused, so cursors stay valid
    expect(w.h.db.channel.id.find(thread)).toBeTruthy();
    expect(w.h.db.member.count()).toBe(1n);
    expect(w.h.db.run.count()).toBe(1n);
  });
  it('is admin only and refuses unknown channels', () => {
    const w = setup();
    expect(() => w.call('bob', mod.clear_channel, { channel_id: w.general })).toThrow(/only an admin/);
    expect(() => w.call('nodeA', mod.clear_channel, { channel_id: w.general })).toThrow(/only an admin/);
    expect(() => w.call('admin', mod.clear_channel, { channel_id: 999n })).toThrow(/no channel/);
  });
  it('clears a DM only for an admin who is in it', () => {
    const w = setup();
    w.call('bob', mod.create_channel, { name: 'dm-a-b', kind: 'dm', parent_id: 0n });
    const dm = [...w.h.db.channel.iter()].find(c => c.kind === 'dm')!.id;
    w.call('nodeA', mod.post_message, msg(dm));
    expect(() => w.call('admin', mod.clear_channel, { channel_id: dm })).toThrow(/DMs they are in/);
    w.call('admin', mod.join, { channel_id: dm, member_kind: 'user', member_id: w.hex('admin') });
    w.call('admin', mod.clear_channel, { channel_id: dm });
    expect([...w.h.db.message.iter()].map(m => m.body)).toEqual(['ryan cleared this channel']);
  });
});
