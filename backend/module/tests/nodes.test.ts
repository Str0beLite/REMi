import { ConnectionId, Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import db from '../src/contract';

let conn = 1n;
const auth = (sub: string) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(conn++));
const BASE = 'nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16';
const AF = (name: string, tools: string, adapters = '[]') =>
  `name: ${name}\npurpose: test\nchannels: [general]\ntriggers: [mention]\ntools: [${tools}]\nbudget: {turns: 5, minutes: 5}\nadapters: ${adapters}\n`;

// Nodes a and b share a base, c doesn't. sleep-remi (1, protected) and oncall (2, with dc-ops@1 and the three tools)
// run on a; helper (3, plain) runs on b.
function setup() {
  const h = createModuleTestHarness(db, mod);
  const as = { admin: auth('admin'), bob: auth('bob'), carol: auth('carol'), nodeA: auth('a'), nodeB: auth('b'), nodeC: auth('c') };
  const id = Object.fromEntries(Object.entries(as).map(([k, a]) => [k, h.withReducerTx(a, ctx => ctx.sender)])) as Record<keyof typeof as, Identity>;
  h.withReducerTx(TestAuth.internal(), ctx => {
    mod.init(ctx, {});
    ctx.db.user.insert({ identity: id.admin, nickname: 'ryan', is_admin: true });
    ctx.db.user.insert({ identity: id.bob, nickname: 'bob', is_admin: false });
    ctx.db.user.insert({ identity: id.carol, nickname: 'carol', is_admin: false });
    const node = (identity: Identity, name: string, base: string) =>
      ctx.db.node.insert({ id: 0n, identity, name, gpu: 'x', base_model: base, status: 'up', last_seen: ctx.timestamp, stats: '{}' });
    const a = node(id.nodeA, 'a', BASE);
    const b = node(id.nodeB, 'b', BASE);
    node(id.nodeC, 'c', 'other-base');
    const agent = (name: string, node_id: bigint, prot: boolean, af: string) =>
      ctx.db.agent.insert({ id: 0n, name, agentfile: af, status: 'idle', node_id, owner: id.bob, protected: prot });
    agent('sleep-remi', a.id, true, AF('sleep-remi', 'say'));
    agent('oncall', a.id, false, AF('oncall', 'say, migrate, agents, send', '[{name: dc-ops, version: 1, weight: 1}]'));
    agent('helper', b.id, false, AF('helper', 'say'));
    ctx.db.adapter.insert({
      id: 0n, key: 'dc-ops@1', name: 'dc-ops', version: 1, node_id: a.id, base: BASE, description: 'ops', sha256: 'ab', size: 10n,
      status: 'adopted', train_stats: '{}', parent_version: 0, dataset_names: '', ts: ctx.timestamp,
    });
  });
  const call = <A>(who: keyof typeof as, fn: (ctx: never, args: A) => void, args: A) => h.withReducerTx(as[who], ctx => fn(ctx as never, args));
  const agent = (n: bigint) => h.db.agent.id.find(n)!;
  const last = () => [...h.db.message.iter()].at(-1)!.body;
  const setStatus = (n: bigint, status: string) => h.withReducerTx(TestAuth.internal(), ctx => ctx.db.agent.id.update({ ...ctx.db.agent.id.find(n)!, status }));
  return { h, call, agent, last, setStatus };
}

const ONCALL = 2n, HELPER = 3n, SLEEP = 1n, A = 1n, B = 2n, C = 3n;

describe('move_agent', () => {
  it('owner or admin starts a move; refuses protected, same node, other base, down and double moves', () => {
    const w = setup();
    expect(() => w.call('carol', mod.move_agent, { agent_id: ONCALL, node_id: B, by_agent: 0n })).toThrow(/owner or an admin/);
    expect(() => w.call('bob', mod.move_agent, { agent_id: SLEEP, node_id: B, by_agent: 0n })).toThrow(/protected/);
    expect(() => w.call('bob', mod.move_agent, { agent_id: ONCALL, node_id: A, by_agent: 0n })).toThrow(/already on/);
    expect(() => w.call('bob', mod.move_agent, { agent_id: ONCALL, node_id: C, by_agent: 0n })).toThrow(/their own base/);
    w.setStatus(ONCALL, 'thinking');
    expect(() => w.call('bob', mod.move_agent, { agent_id: ONCALL, node_id: B, by_agent: 0n })).toThrow(/busy/);
    w.setStatus(ONCALL, 'idle');
    w.call('bob', mod.move_agent, { agent_id: ONCALL, node_id: B, by_agent: 0n });
    expect(w.agent(ONCALL).status).toBe('moving');
    expect(w.h.db.migration.id.find(1n)).toMatchObject({ agent_id: ONCALL, from_node: A, to_node: B, state: 'uploading' });
    expect(w.last()).toBe('bob is moving oncall from a to b');
    expect(() => w.call('admin', mod.move_agent, { agent_id: ONCALL, node_id: B, by_agent: 0n })).toThrow(/already moving/);
  });

  it('/migrate: an agent with the tool moves itself mid-run or another unprotected agent', () => {
    const w = setup();
    expect(() => w.call('nodeB', mod.move_agent, { agent_id: ONCALL, node_id: B, by_agent: ONCALL })).toThrow(/oncall's node/);
    expect(() => w.call('nodeB', mod.move_agent, { agent_id: HELPER, node_id: A, by_agent: HELPER })).toThrow(/migrate tool/);
    expect(() => w.call('nodeA', mod.move_agent, { agent_id: SLEEP, node_id: B, by_agent: ONCALL })).toThrow(/protected/);
    w.setStatus(HELPER, 'thinking');
    expect(() => w.call('nodeA', mod.move_agent, { agent_id: HELPER, node_id: A, by_agent: ONCALL })).toThrow(/busy/);
    w.setStatus(HELPER, 'idle');
    w.call('nodeA', mod.move_agent, { agent_id: HELPER, node_id: A, by_agent: ONCALL });
    expect(w.last()).toBe('oncall is moving helper from b to a');
    w.setStatus(ONCALL, 'thinking');
    w.call('nodeA', mod.move_agent, { agent_id: ONCALL, node_id: B, by_agent: ONCALL }); // itself, mid-run
    expect(w.agent(ONCALL).status).toBe('moving');
  });
});

describe('a migration', () => {
  it('uploads from the old node, finishes on the new one in one step, and copies the LoRA', () => {
    const w = setup();
    w.call('bob', mod.move_agent, { agent_id: ONCALL, node_id: B, by_agent: 0n });
    const chunk = (who: 'nodeA' | 'nodeB', seq: number, data = 'QUJD') => w.call(who, mod.put_blob_chunk, { blob: 'mig:1:dc-ops@1', seq, data });
    expect(() => chunk('nodeB', 0)).toThrow(/not an upload/);
    expect(() => w.call('bob', mod.put_blob_chunk, { blob: 'mig:1:x', seq: 0, data: '' })).toThrow(/only a node/);
    expect(() => w.call('nodeA', mod.put_blob_chunk, { blob: 'other:1', seq: 0, data: '' })).toThrow(/mig: or file:/);
    expect(() => chunk('nodeA', 0, 'x'.repeat(262_145))).toThrow(/at most/);
    chunk('nodeA', 0);
    chunk('nodeA', 0, 'REVG'); // a retry replaces the chunk
    chunk('nodeA', 1);
    expect(w.h.db.blob_chunk.count()).toBe(2n);
    w.call('nodeA', mod.set_agent_status, { agent_id: ONCALL, status: 'idle' }); // the old run ending can't clobber "moving"
    expect(w.agent(ONCALL).status).toBe('moving');
    expect(() => w.call('nodeB', mod.finish_migration, { id: 1n })).toThrow(/is uploading/);
    expect(() => w.call('nodeB', mod.migration_ready, { id: 1n })).toThrow(/moves from/);
    w.call('nodeA', mod.migration_ready, { id: 1n });
    expect(() => w.call('nodeA', mod.finish_migration, { id: 1n })).toThrow(/moves to/);
    w.call('nodeB', mod.finish_migration, { id: 1n });
    expect(w.agent(ONCALL)).toMatchObject({ node_id: B, status: 'idle' });
    expect(w.h.db.migration.id.find(1n)?.state).toBe('done');
    expect([...w.h.db.adapter_copy.iter()]).toEqual([{ id: 1n, key: 'dc-ops@1', node_id: B }]);
    expect(w.h.db.blob_chunk.count()).toBe(0n);
    expect(w.last()).toBe('oncall moved to b');
    // Back to a: a already has the files, so no second copy row.
    w.call('bob', mod.move_agent, { agent_id: ONCALL, node_id: A, by_agent: 0n });
    w.call('nodeB', mod.migration_ready, { id: 2n });
    w.call('nodeA', mod.finish_migration, { id: 2n });
    expect(w.h.db.adapter_copy.count()).toBe(1n);
  });

  it('fails cleanly: the agent stays put and the chunks go', () => {
    const w = setup();
    w.call('bob', mod.move_agent, { agent_id: ONCALL, node_id: B, by_agent: 0n });
    w.call('nodeA', mod.put_blob_chunk, { blob: 'mig:1:dc-ops@1', seq: 0, data: 'QUJD' });
    expect(() => w.call('carol', mod.fail_migration, { id: 1n, note: 'x' })).toThrow(/its nodes or an admin/);
    w.call('nodeB', mod.fail_migration, { id: 1n, note: 'sha256 mismatch' });
    expect(w.agent(ONCALL)).toMatchObject({ node_id: A, status: 'idle' });
    expect(w.h.db.migration.id.find(1n)).toMatchObject({ state: 'failed', note: 'sha256 mismatch' });
    expect(w.h.db.blob_chunk.count()).toBe(0n);
    expect(w.last()).toBe('Moving oncall failed: sha256 mismatch');
    expect(() => w.call('admin', mod.fail_migration, { id: 1n, note: 'again' })).toThrow(/is failed/);
  });
});

describe('attach_adapter', () => {
  it("needs the adapter's files on the agent's node", () => {
    const w = setup();
    expect(() => w.call('admin', mod.attach_adapter, { agent_id: HELPER, name: 'dc-ops', version: 1, weight: 1 })).toThrow(/aren't on b/);
    w.h.withReducerTx(TestAuth.internal(), ctx => ctx.db.adapter_copy.insert({ id: 0n, key: 'dc-ops@1', node_id: B }));
    w.call('admin', mod.attach_adapter, { agent_id: HELPER, name: 'dc-ops', version: 1, weight: 1 });
    expect(w.agent(HELPER).agentfile).toContain('dc-ops');
  });
});

describe('sending a file', () => {
  const up = (w: ReturnType<typeof setup>, seq: number) => w.call('nodeA', mod.put_blob_chunk, { blob: 'file:n1:report.txt', seq, data: 'aGk=' });
  const send = { blob: 'file:n1:report.txt', name: 'report.txt', size: 12n, sha256: 'ff', chunks: 2, from_agent: ONCALL, to_agent: HELPER, channel_id: 1n, note: 'disk report' };

  it('checks the sender, chunks and limits, then delivers with an @mention', () => {
    const w = setup();
    up(w, 0);
    expect(() => w.call('nodeA', mod.send_file, send)).toThrow(/chunk 1/);
    up(w, 1);
    expect(() => w.call('nodeB', mod.send_file, send)).toThrow(/oncall's node/);
    expect(() => w.call('nodeA', mod.send_file, { ...send, to_agent: ONCALL })).toThrow(/yourself/);
    expect(() => w.call('nodeA', mod.send_file, { ...send, name: '../etc' })).toThrow(/file names/);
    expect(() => w.call('nodeA', mod.send_file, { ...send, size: 52_428_801n })).toThrow(/50 MB/);
    w.call('nodeA', mod.send_file, send);
    expect(w.h.db.file_transfer.id.find(1n)?.state).toBe('sent');
    expect(() => w.call('nodeA', mod.file_delivered, { id: 1n })).toThrow(/recipient's node/);
    w.call('nodeB', mod.file_delivered, { id: 1n });
    expect(w.h.db.file_transfer.id.find(1n)?.state).toBe('delivered');
    expect(w.h.db.blob_chunk.count()).toBe(0n);
    expect(w.last()).toBe('@helper oncall sent you /shared/report.txt (12 B) — disk report');
  });

  it('a failed delivery tells the sender', () => {
    const w = setup();
    up(w, 0);
    up(w, 1);
    w.call('nodeA', mod.send_file, send);
    w.call('nodeB', mod.file_failed, { id: 1n, note: 'sha256 mismatch' });
    expect(w.h.db.file_transfer.id.find(1n)?.state).toBe('failed');
    expect(w.h.db.blob_chunk.count()).toBe(0n);
    expect(w.last()).toBe('@oncall sending report.txt to helper failed: sha256 mismatch');
  });
});

describe('starting and stopping', () => {
  it('start_agent: owner or admin, stopped agents only', () => {
    const w = setup();
    expect(() => w.call('bob', mod.start_agent, { agent_id: HELPER })).toThrow(/idle, not stopped/);
    w.call('bob', mod.stop_agent, { agent_id: HELPER });
    expect(() => w.call('carol', mod.start_agent, { agent_id: HELPER })).toThrow(/owner or an admin/);
    w.call('bob', mod.start_agent, { agent_id: HELPER });
    expect(w.agent(HELPER).status).toBe('idle');
  });

  it('control_agent: an agent with /agents stops and starts unprotected agents, logged in #ops', () => {
    const w = setup();
    expect(() => w.call('nodeB', mod.control_agent, { agent_id: ONCALL, action: 'stop', by_agent: HELPER })).toThrow(/agents tool/);
    expect(() => w.call('nodeA', mod.control_agent, { agent_id: SLEEP, action: 'stop', by_agent: ONCALL })).toThrow(/protected/);
    expect(() => w.call('nodeA', mod.control_agent, { agent_id: HELPER, action: 'pause', by_agent: ONCALL })).toThrow(/stop or start/);
    w.call('nodeA', mod.control_agent, { agent_id: HELPER, action: 'stop', by_agent: ONCALL });
    expect(w.agent(HELPER).status).toBe('stopped');
    expect(w.last()).toBe('oncall stopped helper');
    w.call('nodeA', mod.control_agent, { agent_id: HELPER, action: 'start', by_agent: ONCALL });
    expect(w.agent(HELPER).status).toBe('idle');
  });
});
