import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionId, Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import db from '../src/contract';

const root = join(import.meta.dirname, '../../..');
const yamls = (dir: string): [string, string][] =>
  readdirSync(join(root, dir))
    .filter(f => f.endsWith('.yaml'))
    .map(f => [f, readFileSync(join(root, dir, f), 'utf8')]);
const AF = (name: string, channels = '[general]') =>
  `name: ${name}\npurpose: test\nchannels: ${channels}\ntriggers: [mention]\ntools: [say]\nbudget: {turns: 5, minutes: 5}\nadapters: []\n`;

let conn = 1n;
const auth = (sub: string) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(conn++));

// World: admin, owner bob, user carol, node A (registered rows), node B, and a stranger.
function setup() {
  const h = createModuleTestHarness(db, mod);
  const as = { admin: auth('admin'), bob: auth('bob'), carol: auth('carol'), nodeA: auth('node-a'), nodeB: auth('node-b'), stranger: auth('x') };
  const id = Object.fromEntries(Object.entries(as).map(([k, a]) => [k, h.withReducerTx(a, ctx => ctx.sender)])) as Record<keyof typeof as, Identity>;
  h.withReducerTx(TestAuth.internal(), ctx => {
    mod.init(ctx, {});
    ctx.db.user.insert({ identity: id.admin, nickname: 'ryan', is_admin: true });
    ctx.db.user.insert({ identity: id.bob, nickname: 'bob', is_admin: false });
    ctx.db.user.insert({ identity: id.carol, nickname: 'carol', is_admin: false });
    for (const [k, name] of [['nodeA', 'node-a'], ['nodeB', 'node-b']] as const)
      ctx.db.node.insert({ id: 0n, identity: id[k], name, gpu: 'x', base_model: 'm', status: 'up', last_seen: ctx.timestamp, stats: '{}' });
  });
  const call = <A>(who: keyof typeof as, fn: (ctx: never, args: A) => void, args: A) =>
    h.withReducerTx(as[who], ctx => fn(ctx as never, args));
  const agent = (name: string) => [...h.db.agent.iter()].find(a => a.name === name)!;
  const channelsOf = (agentId: bigint) =>
    [...h.db.member.iter()]
      .filter(m => m.member_kind === 'agent' && m.member_id === agentId.toString())
      .map(m => h.db.channel.id.find(m.channel_id)!.name)
      .sort();
  const create = (name: string, channels?: string) => call('bob', mod.create_agent, { agentfile: AF(name, channels), node_id: 1n });
  return { h, id, call, agent, channelsOf, create };
}

describe('register_node and heartbeat', () => {
  it('lets an admin register its own identity as a node and re-register to update it', () => {
    const w = setup();
    w.call('admin', mod.register_node, { name: 'gpu-01', gpu: '5070 Ti', base_model: 'nano-4b' });
    w.call('admin', mod.register_node, { name: 'gpu-01', gpu: '4090', base_model: 'nano-4b' });
    const n = [...w.h.db.node.iter()].filter(n => n.name === 'gpu-01');
    expect(n).toHaveLength(1);
    expect(n[0].gpu).toBe('4090');
  });
  it('rejects non-admins and names owned by another identity', () => {
    const w = setup();
    expect(() => w.call('bob', mod.register_node, { name: 'gpu-02', gpu: 'x', base_model: 'm' })).toThrow(/only an admin/);
    expect(() => w.call('admin', mod.register_node, { name: 'node-a', gpu: 'x', base_model: 'm' })).toThrow(/another identity/);
    expect(() => w.call('admin', mod.register_node, { name: 'GPU 2', gpu: 'x', base_model: 'm' })).toThrow(/lowercase/);
  });
  it('lets only the node itself heartbeat, with a known status', () => {
    const w = setup();
    w.call('nodeA', mod.heartbeat, { node_id: 1n, status: 'asleep' });
    expect(w.h.db.node.id.find(1n)?.status).toBe('asleep');
    expect(() => w.call('nodeB', mod.heartbeat, { node_id: 1n, status: 'up' })).toThrow(/only that node/);
    expect(() => w.call('nodeA', mod.heartbeat, { node_id: 1n, status: 'napping' })).toThrow(/node status/);
  });
});

describe('create_agent', () => {
  it.each(yamls('fixtures/agentfiles'))('accepts %s', (_f, text) => {
    const w = setup();
    w.call('bob', mod.create_agent, { agentfile: text, node_id: 1n });
    const a = [...w.h.db.agent.iter()][0];
    expect(a.status).toBe('idle');
    expect(w.h.db.config_history.count()).toBe(1n);
  });
  it.each(yamls('fixtures/agentfiles/invalid'))('rejects %s', (_f, text) => {
    const w = setup();
    expect(() => w.call('bob', mod.create_agent, { agentfile: text, node_id: 1n })).toThrow(/invalid Agentfile/);
  });
  it('joins the Agentfile channels, creating missing public ones', () => {
    const w = setup();
    w.create('oncall', '[general, capacity]');
    expect(w.channelsOf(w.agent('oncall').id)).toEqual(['capacity', 'general']);
  });
  it('rejects bad YAML, duplicate names, unknown nodes and callers without a nickname', () => {
    const w = setup();
    w.create('oncall');
    expect(() => w.create('oncall')).toThrow(/already exists/);
    expect(() => w.call('bob', mod.create_agent, { agentfile: 'name: [', node_id: 1n })).toThrow(/not valid YAML/);
    expect(() => w.call('bob', mod.create_agent, { agentfile: AF('x2'), node_id: 9n })).toThrow(/no node/);
    expect(() => w.call('stranger', mod.create_agent, { agentfile: AF('x3'), node_id: 1n })).toThrow(/nickname/);
  });
});

describe('update_agentfile', () => {
  it('re-syncs public memberships, keeps thread memberships and logs history', () => {
    const w = setup();
    w.create('oncall', '[general, capacity]');
    const a = w.agent('oncall');
    w.h.withReducerTx(TestAuth.internal(), ctx => {
      const th = ctx.db.channel.insert({ id: 0n, name: 't', kind: 'thread', parent_id: 1n, created_by: w.id.bob, ts: ctx.timestamp });
      ctx.db.member.insert({ id: 0n, channel_id: th.id, member_kind: 'agent', member_id: a.id.toString() });
    });
    w.call('bob', mod.update_agentfile, { agent_id: a.id, agentfile: AF('oncall', '[ops]') });
    expect(w.channelsOf(a.id)).toEqual(['ops', 't']);
    expect(w.h.db.config_history.count()).toBe(2n);
  });
  it('allows only the owner or an admin', () => {
    const w = setup();
    w.create('oncall');
    const a = w.agent('oncall');
    expect(() => w.call('carol', mod.update_agentfile, { agent_id: a.id, agentfile: AF('oncall') })).toThrow(/owner or an admin/);
    w.call('admin', mod.update_agentfile, { agent_id: a.id, agentfile: AF('oncall', '[ops]') });
  });
  it('lets only an admin change a protected agent, even its owner cannot', () => {
    const w = setup();
    w.create('sleep-remi');
    const a = w.agent('sleep-remi');
    w.h.withReducerTx(TestAuth.internal(), ctx => ctx.db.agent.id.update({ ...a, protected: true }));
    expect(() => w.call('bob', mod.update_agentfile, { agent_id: a.id, agentfile: AF('sleep-remi', '[ops]') })).toThrow(/protected/);
    w.call('admin', mod.update_agentfile, { agent_id: a.id, agentfile: AF('sleep-remi', '[ops]') });
    expect(w.channelsOf(a.id)).toEqual(['ops']);
  });
  it('rejects renaming onto another agent and invalid Agentfiles', () => {
    const w = setup();
    w.create('oncall');
    w.create('toolsmith');
    const a = w.agent('oncall');
    expect(() => w.call('bob', mod.update_agentfile, { agent_id: a.id, agentfile: AF('toolsmith') })).toThrow(/already exists/);
    expect(() => w.call('bob', mod.update_agentfile, { agent_id: a.id, agentfile: 'name: x' })).toThrow(/invalid Agentfile/);
  });
});

describe('set_agent_status, stop_agent, rollback_agent', () => {
  it("lets only the agent's node set its status", () => {
    const w = setup();
    w.create('oncall');
    const a = w.agent('oncall');
    w.call('nodeA', mod.set_agent_status, { agent_id: a.id, status: 'thinking' });
    expect(w.agent('oncall').status).toBe('thinking');
    expect(() => w.call('nodeB', mod.set_agent_status, { agent_id: a.id, status: 'idle' })).toThrow(/node can do this/);
    expect(() => w.call('nodeA', mod.set_agent_status, { agent_id: a.id, status: 'dancing' })).toThrow(/agent status/);
  });
  it('stops the agent and ends only its running run', () => {
    const w = setup();
    w.create('oncall');
    const a = w.agent('oncall');
    w.h.withReducerTx(TestAuth.internal(), ctx => {
      for (const state of ['running', 'done'])
        ctx.db.run.insert({ id: 0n, agent_id: a.id, channel_id: 1n, trigger_msg_id: 0n, turns: 1, started: ctx.timestamp, state });
    });
    w.call('bob', mod.stop_agent, { agent_id: a.id });
    expect(w.agent('oncall').status).toBe('stopped');
    expect([...w.h.db.run.iter()].map(r => r.state).sort()).toEqual(['done', 'stopped']);
    expect(() => w.call('carol', mod.stop_agent, { agent_id: a.id })).toThrow(/owner or an admin/);
  });
  it('lets an admin roll back to an earlier Agentfile, logging a new history row', () => {
    const w = setup();
    w.create('oncall', '[general]');
    const a = w.agent('oncall');
    const first = [...w.h.db.config_history.iter()][0].id;
    w.call('bob', mod.update_agentfile, { agent_id: a.id, agentfile: AF('oncall', '[ops]') });
    expect(() => w.call('bob', mod.rollback_agent, { agent_id: a.id, history_id: first })).toThrow(/only an admin/);
    w.call('admin', mod.rollback_agent, { agent_id: a.id, history_id: first });
    expect(w.channelsOf(a.id)).toEqual(['general']);
    expect(w.h.db.config_history.count()).toBe(3n);
    expect(() => w.call('admin', mod.rollback_agent, { agent_id: a.id, history_id: 99n })).toThrow(/not agent/);
  });
});
