import { ConnectionId, Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import db from '../src/contract';

let conn = 1n;
const auth = (sub: string) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(conn++));

// World: admin, user bob, node A running agent 1, node B running agent 2.
function setup() {
  const h = createModuleTestHarness(db, mod);
  const as = { admin: auth('admin'), bob: auth('bob'), nodeA: auth('node-a'), nodeB: auth('node-b') };
  const id = Object.fromEntries(Object.entries(as).map(([k, a]) => [k, h.withReducerTx(a, ctx => ctx.sender)])) as Record<keyof typeof as, Identity>;
  h.withReducerTx(TestAuth.internal(), ctx => {
    mod.init(ctx, {});
    ctx.db.user.insert({ identity: id.admin, nickname: 'ryan', is_admin: true });
    ctx.db.user.insert({ identity: id.bob, nickname: 'bob', is_admin: false });
    for (const [k, name] of [['nodeA', 'node-a'], ['nodeB', 'node-b']] as const) {
      const n = ctx.db.node.insert({ id: 0n, identity: id[k], name, gpu: 'x', base_model: 'm', status: 'up', last_seen: ctx.timestamp });
      ctx.db.agent.insert({ id: 0n, name: `agent-${name}`, agentfile: '', status: 'idle', node_id: n.id, owner: id.bob, protected: false });
    }
  });
  const call = <A>(who: keyof typeof as, fn: (ctx: never, args: A) => void, args: A) =>
    h.withReducerTx(as[who], ctx => fn(ctx as never, args));
  return { h, call };
}

const tool = (name = 'host_power', over = {}) => ({ name, code: 'print(1)', docs: 'Reads power.', author_agent: 1n, dry_run: '{"out":"612 W"}', ...over });

describe('propose_tool and review_tool', () => {
  it('versions tools by name and builds name@version keys', () => {
    const w = setup();
    w.call('nodeA', mod.propose_tool, tool());
    w.call('nodeA', mod.propose_tool, tool());
    w.call('nodeA', mod.propose_tool, tool('pdu_reading'));
    expect([...w.h.db.tool.iter()].map(x => x.key).sort()).toEqual(['host_power@1', 'host_power@2', 'pdu_reading@1']);
    expect(w.h.db.tool.key.find('host_power@2')?.status).toBe('pending');
  });
  it('rejects built-in and malformed names, bad dry runs and other nodes', () => {
    const w = setup();
    expect(() => w.call('nodeA', mod.propose_tool, tool('sh'))).toThrow(/built-in/);
    expect(() => w.call('nodeA', mod.propose_tool, tool('Host-Power'))).toThrow(/tool names/);
    expect(() => w.call('nodeA', mod.propose_tool, tool('x1', { dry_run: 'nope' }))).toThrow(/valid JSON/);
    expect(() => w.call('nodeB', mod.propose_tool, tool())).toThrow(/node can do this/);
    expect(() => w.call('bob', mod.propose_tool, tool())).toThrow(/node can do this/);
  });
  it('lets only an admin review, once', () => {
    const w = setup();
    w.call('nodeA', mod.propose_tool, tool());
    expect(() => w.call('bob', mod.review_tool, { key: 'host_power@1', approve: true, note: '' })).toThrow(/only an admin/);
    w.call('admin', mod.review_tool, { key: 'host_power@1', approve: true, note: 'read-only' });
    const t = w.h.db.tool.key.find('host_power@1')!;
    expect([t.status, t.review_note, t.reviewer !== undefined]).toEqual(['approved', 'read-only', true]);
    expect(() => w.call('admin', mod.review_tool, { key: 'host_power@1', approve: false, note: '' })).toThrow(/already approved/);
    expect(() => w.call('admin', mod.review_tool, { key: 'nope@1', approve: true, note: '' })).toThrow(/no tool/);
  });
});

describe('memory and todos', () => {
  it("lets the agent's node or an admin add memories; any node or admin edits", () => {
    const w = setup();
    w.call('nodeA', mod.add_memory, { agent_id: 1n, text: 'PDU-2 p95 is 7.1 kW' });
    w.call('admin', mod.add_memory, { agent_id: 1n, text: 'second' });
    expect(() => w.call('nodeB', mod.add_memory, { agent_id: 1n, text: 'x' })).toThrow(/node or an admin/);
    expect(() => w.call('bob', mod.add_memory, { agent_id: 1n, text: 'x' })).toThrow(/node or an admin/);
    expect(() => w.call('nodeA', mod.add_memory, { agent_id: 1n, text: 'x'.repeat(2001) })).toThrow(/2000/);
    w.call('nodeB', mod.edit_memory, { memory_id: 1n, text: 'PDU-2 p95 is 7.2 kW' });
    expect(w.h.db.memory.id.find(1n)?.text).toBe('PDU-2 p95 is 7.2 kW');
    expect(() => w.call('bob', mod.edit_memory, { memory_id: 1n, text: 'x' })).toThrow(/node or an admin/);
  });
  it("lets only the agent's node add and finish todos", () => {
    const w = setup();
    w.call('nodeA', mod.todo_add, { agent_id: 1n, text: 'check B14 tomorrow' });
    expect(() => w.call('nodeB', mod.todo_add, { agent_id: 1n, text: 'x' })).toThrow(/node can do this/);
    expect(() => w.call('nodeB', mod.todo_done, { todo_id: 1n })).toThrow(/node can do this/);
    w.call('nodeA', mod.todo_done, { todo_id: 1n });
    expect(w.h.db.todo.id.find(1n)?.status).toBe('done');
  });
});

describe('runs', () => {
  it('refuses a second running run for the same agent and channel', () => {
    const w = setup();
    w.call('nodeA', mod.run_start, { agent_id: 1n, channel_id: 1n, trigger_msg_id: 0n });
    expect(() => w.call('nodeA', mod.run_start, { agent_id: 1n, channel_id: 1n, trigger_msg_id: 0n })).toThrow(/already has a running run/);
    w.call('nodeA', mod.run_start, { agent_id: 1n, channel_id: 2n, trigger_msg_id: 0n });
    expect(w.h.db.run.count()).toBe(2n);
  });
  it('counts turns and ends runs, only from the agent node and only once', () => {
    const w = setup();
    w.call('nodeA', mod.run_start, { agent_id: 1n, channel_id: 1n, trigger_msg_id: 0n });
    w.call('nodeA', mod.run_turn, { run_id: 1n });
    w.call('nodeA', mod.run_turn, { run_id: 1n });
    expect(() => w.call('nodeB', mod.run_turn, { run_id: 1n })).toThrow(/node can do this/);
    expect(() => w.call('nodeA', mod.run_end, { run_id: 1n, state: 'running' })).toThrow(/end state/);
    w.call('nodeA', mod.run_end, { run_id: 1n, state: 'budget' });
    expect(w.h.db.run.id.find(1n)).toMatchObject({ turns: 2, state: 'budget' });
    expect(() => w.call('nodeA', mod.run_turn, { run_id: 1n })).toThrow(/already ended/);
    w.call('nodeA', mod.run_start, { agent_id: 1n, channel_id: 1n, trigger_msg_id: 0n });
  });
});

describe('set_setting', () => {
  it('lets only an admin change or add settings', () => {
    const w = setup();
    w.call('admin', mod.set_setting, { key: 'sleep_cron', value: '0 2 * * *' });
    w.call('admin', mod.set_setting, { key: 'new_key', value: '1' });
    expect(w.h.db.setting.key.find('sleep_cron')?.value).toBe('0 2 * * *');
    expect(w.h.db.setting.key.find('new_key')?.value).toBe('1');
    expect(() => w.call('bob', mod.set_setting, { key: 'sleep_cron', value: 'x' })).toThrow(/only an admin/);
    expect(() => w.call('nodeA', mod.set_setting, { key: 'sleep_cron', value: 'x' })).toThrow(/only an admin/);
  });
});
