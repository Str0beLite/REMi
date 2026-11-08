import { ConnectionId, Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import { parse } from 'yaml';
import * as mod from '../src/index';
import db from '../src/contract';

let conn = 1n;
const auth = (sub: string) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(conn++));
const BASE = 'nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16';
const AF = (name: string) =>
  `name: ${name}\npurpose: test\nchannels: [general]\ntriggers: [mention]\ntools: [say]\nbudget: {turns: 5, minutes: 5}\nadapters: []\n`;

// World: admin, user bob; node A (base Nano) runs sleep-remi (protected, id 1) and oncall (id 2);
// node B (other base) runs helper (id 3); node C runs nothing protected.
function setup() {
  const h = createModuleTestHarness(db, mod);
  const as = { admin: auth('admin'), bob: auth('bob'), nodeA: auth('a'), nodeB: auth('b'), nodeC: auth('c') };
  const id = Object.fromEntries(Object.entries(as).map(([k, a]) => [k, h.withReducerTx(a, ctx => ctx.sender)])) as Record<keyof typeof as, Identity>;
  h.withReducerTx(TestAuth.internal(), ctx => {
    mod.init(ctx, {});
    ctx.db.user.insert({ identity: id.admin, nickname: 'ryan', is_admin: true });
    ctx.db.user.insert({ identity: id.bob, nickname: 'bob', is_admin: false });
    const node = (identity: Identity, name: string, base: string) =>
      ctx.db.node.insert({ id: 0n, identity, name, gpu: 'x', base_model: base, status: 'up', last_seen: ctx.timestamp });
    const a = node(id.nodeA, 'a', BASE);
    const b = node(id.nodeB, 'b', 'other-base');
    node(id.nodeC, 'c', BASE);
    const agent = (name: string, node_id: bigint, prot: boolean) =>
      ctx.db.agent.insert({ id: 0n, name, agentfile: AF(name), status: 'idle', node_id, owner: id.bob, protected: prot });
    agent('sleep-remi', a.id, true);
    agent('oncall', a.id, false);
    agent('helper', b.id, false);
  });
  const call = <A>(who: keyof typeof as, fn: (ctx: never, args: A) => void, args: A) =>
    h.withReducerTx(as[who], ctx => fn(ctx as never, args));
  const adapters = (agentId: bigint) => parse(h.db.agent.id.find(agentId)!.agentfile).adapters;
  return { h, call, adapters };
}

const reg = (over = {}) => ({
  name: 'dc-ops', version: 1, node_id: 1n, base: BASE, description: 'ops', sha256: 'ab', size: 10n,
  train_stats: '{"judge_before":0.81,"judge_after":0.88}', parent_version: 0, dataset_names: 'day-1', ...over,
});

describe('register_dataset', () => {
  it('upserts by name from that node only', () => {
    const w = setup();
    const ds = { name: 'day-1', node_id: 1n, n_examples: 60, sha256: 'x', description: 'd', created_by: '1' };
    w.call('nodeA', mod.register_dataset, ds);
    w.call('nodeA', mod.register_dataset, { ...ds, n_examples: 80 });
    expect(w.h.db.dataset.count()).toBe(1n);
    expect(w.h.db.dataset.name.find('day-1')?.n_examples).toBe(80);
    expect(() => w.call('nodeB', mod.register_dataset, ds)).toThrow(/only node 1/);
    expect(() => w.call('nodeA', mod.register_dataset, { ...ds, name: 'Day 1' })).toThrow(/lowercase/);
  });
});

describe('register_adapter', () => {
  it('always creates a candidate keyed name@version', () => {
    const w = setup();
    w.call('nodeA', mod.register_adapter, reg());
    const a = w.h.db.adapter.key.find('dc-ops@1')!;
    expect(a.status).toBe('candidate');
  });
  it("rejects other nodes, a different base, duplicates and bad train_stats", () => {
    const w = setup();
    expect(() => w.call('nodeB', mod.register_adapter, reg())).toThrow(/only node 1/);
    expect(() => w.call('nodeA', mod.register_adapter, reg({ base: 'other-base' }))).toThrow(/not this node's base/);
    w.call('nodeA', mod.register_adapter, reg());
    expect(() => w.call('nodeA', mod.register_adapter, reg())).toThrow(/already exists/);
    expect(() => w.call('nodeA', mod.register_adapter, reg({ version: 2, train_stats: 'x' }))).toThrow(/valid JSON/);
  });
});

describe('set_adapter_status', () => {
  it('lets an admin or the protected agent node change status; others cannot', () => {
    const w = setup();
    w.call('nodeA', mod.register_adapter, reg());
    w.call('nodeA', mod.set_adapter_status, { key: 'dc-ops@1', status: 'adopted' });
    w.call('admin', mod.set_adapter_status, { key: 'dc-ops@1', status: 'rejected' });
    expect(w.h.db.adapter.key.find('dc-ops@1')?.status).toBe('rejected');
    expect(() => w.call('nodeC', mod.set_adapter_status, { key: 'dc-ops@1', status: 'adopted' })).toThrow(/admin or Sleep REMi/);
    expect(() => w.call('bob', mod.set_adapter_status, { key: 'dc-ops@1', status: 'adopted' })).toThrow(/admin or Sleep REMi/);
    expect(() => w.call('admin', mod.set_adapter_status, { key: 'dc-ops@1', status: 'great' })).toThrow(/unknown adapter status/);
  });
});

describe('attach_adapter', () => {
  const adopted = () => {
    const w = setup();
    w.call('nodeA', mod.register_adapter, reg());
    w.call('admin', mod.set_adapter_status, { key: 'dc-ops@1', status: 'adopted' });
    return w;
  };

  it('rewrites the Agentfile adapters, replaces by name, removes at weight 0, and logs history', () => {
    const w = adopted();
    w.call('nodeA', mod.attach_adapter, { agent_id: 2n, name: 'dc-ops', version: 1, weight: 0.6 });
    expect(w.adapters(2n)).toEqual([{ name: 'dc-ops', version: 1, weight: 0.6 }]);
    w.call('nodeA', mod.attach_adapter, { agent_id: 2n, name: 'dc-ops', version: 1, weight: 0.8 });
    expect(w.adapters(2n)).toEqual([{ name: 'dc-ops', version: 1, weight: 0.8 }]);
    w.call('admin', mod.attach_adapter, { agent_id: 2n, name: 'dc-ops', version: 1, weight: 0 });
    expect(w.adapters(2n)).toEqual([]);
    expect(w.h.db.config_history.count()).toBe(3n);
  });

  it('refuses adapters that are not adopted', () => {
    const w = setup();
    w.call('nodeA', mod.register_adapter, reg());
    expect(() => w.call('admin', mod.attach_adapter, { agent_id: 2n, name: 'dc-ops', version: 1, weight: 1 })).toThrow(/candidate, not adopted/);
    expect(() => w.call('admin', mod.attach_adapter, { agent_id: 2n, name: 'nope', version: 1, weight: 1 })).toThrow(/no adapter/);
  });

  it("stops Sleep REMi's node attaching onto a protected agent; an admin can", () => {
    const w = adopted();
    expect(() => w.call('nodeA', mod.attach_adapter, { agent_id: 1n, name: 'dc-ops', version: 1, weight: 1 })).toThrow(/protected agent/);
    w.call('admin', mod.attach_adapter, { agent_id: 1n, name: 'dc-ops', version: 1, weight: 1 });
    expect(w.adapters(1n)).toEqual([{ name: 'dc-ops', version: 1, weight: 1 }]);
  });

  it('refuses other callers, other bases and out-of-range weights', () => {
    const w = adopted();
    expect(() => w.call('nodeC', mod.attach_adapter, { agent_id: 2n, name: 'dc-ops', version: 1, weight: 1 })).toThrow(/admin or Sleep REMi/);
    expect(() => w.call('bob', mod.attach_adapter, { agent_id: 2n, name: 'dc-ops', version: 1, weight: 1 })).toThrow(/admin or Sleep REMi/);
    expect(() => w.call('admin', mod.attach_adapter, { agent_id: 3n, name: 'dc-ops', version: 1, weight: 1 })).toThrow(/not this agent's base/);
    expect(() => w.call('admin', mod.attach_adapter, { agent_id: 2n, name: 'dc-ops', version: 1, weight: 2.5 })).toThrow(/between 0 and 2/);
  });
});
