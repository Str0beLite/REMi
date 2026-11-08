import { ConnectionId, Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import db from '../src/contract';

let conn = 1n;
const auth = (sub: string) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(conn++));

const AF = (name: string, tools = '[say, note]', extra = '') =>
  `name: ${name}\npurpose: test\nchannels: [general, capacity]\ntriggers: [mention]\ntools: ${tools}\nbudget: {turns: 5, minutes: 5}\nadapters: []\n${extra}`;

// World: admin, user bob; node A runs `toolsmith` (agent 1: say, note, sh, registry:*) and `sleep-remi` (agent 2);
// node B runs `other` (agent 3).
function setup() {
  const h = createModuleTestHarness(db, mod);
  const as = { admin: auth('admin'), bob: auth('bob'), nodeA: auth('a'), nodeB: auth('b') };
  const id = Object.fromEntries(Object.entries(as).map(([k, a]) => [k, h.withReducerTx(a, ctx => ctx.sender)])) as Record<keyof typeof as, Identity>;
  h.withReducerTx(TestAuth.internal(), ctx => {
    mod.init(ctx, {});
    ctx.db.user.insert({ identity: id.admin, nickname: 'ryan', is_admin: true });
    ctx.db.user.insert({ identity: id.bob, nickname: 'bob', is_admin: false });
    const node = (identity: Identity, name: string) =>
      ctx.db.node.insert({ id: 0n, identity, name, gpu: 'x', base_model: 'm', status: 'up', last_seen: ctx.timestamp });
    const a = node(id.nodeA, 'a');
    const b = node(id.nodeB, 'b');
    const agent = (name: string, node_id: bigint, tools: string, prot = false) =>
      ctx.db.agent.insert({ id: 0n, name, agentfile: AF(name, tools), status: 'idle', node_id, owner: id.admin, protected: prot });
    agent('toolsmith', a.id, '[say, note, sh, "registry:*"]');
    agent('sleep-remi', a.id, '[say, note, sleep, dataset, adapter]', true);
    agent('other', b.id, '[say]');
  });
  const call = <A>(who: keyof typeof as, fn: (ctx: never, args: A) => void, args: A) =>
    h.withReducerTx(as[who], ctx => fn(ctx as never, args));
  const propose = (agentfile: string, who: keyof typeof as = 'nodeA', author_agent = 1n) =>
    call(who, mod.propose_agent, { agentfile, author_agent, reason: 'Capacity questions keep coming up' });
  return { h, id, call, propose };
}

describe('propose_agent', () => {
  it('stores a pending proposal on the author node', () => {
    const w = setup();
    w.propose(AF('capacity', '[say, sh, "registry:host_power"]'));
    const [p] = [...w.h.db.agent_proposal.iter()];
    expect(p).toMatchObject({ status: 'pending', node_id: 1n, author_agent: 1n, agent_id: 0n, review_note: '' });
    expect(p.reviewer).toBeUndefined();
    expect(w.h.db.agent.count()).toBe(3n);
  });

  it('rejects an invalid Agentfile', () => {
    const w = setup();
    expect(() => w.propose('name: Bad Name\n')).toThrow(/invalid Agentfile/);
  });

  it('rejects a name taken by an agent or a pending proposal', () => {
    const w = setup();
    expect(() => w.propose(AF('other'))).toThrow(/agent named other already exists/);
    w.propose(AF('capacity'));
    expect(() => w.propose(AF('capacity'))).toThrow(/pending proposal already uses the name capacity/);
  });

  it("rejects tools the author doesn't have and any Sleep REMi command", () => {
    const w = setup();
    expect(() => w.propose(AF('x1', '[say, fetch]'))).toThrow(/can't give tools it doesn't have: fetch/);
    expect(() => w.propose(AF('x2', '[say, sleep]'), 'nodeA', 2n)).toThrow(/Sleep REMi commands: sleep/);
    expect(() => w.propose(AF('x3', '["registry:*"]'), 'nodeB', 3n)).toThrow(/doesn't have: registry:\*/);
  });

  it('rejects non-empty adapters', () => {
    const w = setup();
    const af = AF('x4').replace('adapters: []', 'adapters:\n  - {name: dc-ops, version: 1, weight: 1}');
    expect(() => w.propose(af)).toThrow(/adapters must be \[\]/);
  });

  it("rejects a caller that isn't the author's node, and an empty reason", () => {
    const w = setup();
    expect(() => w.propose(AF('x5'), 'nodeB', 1n)).toThrow(/only agent 1's node/);
    expect(() => w.propose(AF('x6'), 'bob', 1n)).toThrow(/only agent 1's node/);
    expect(() => w.call('nodeA', mod.propose_agent, { agentfile: AF('x7'), author_agent: 1n, reason: '  ' })).toThrow(/give a reason/);
  });
});

describe('review_agent', () => {
  it('approve creates the agent like create_agent and stores agent_id', () => {
    const w = setup();
    w.propose(AF('capacity'));
    w.call('admin', mod.review_agent, { id: 1n, approve: true, note: 'go' });
    const p = w.h.db.agent_proposal.id.find(1n)!;
    const a = w.h.db.agent.name.find('capacity')!;
    expect(p).toMatchObject({ status: 'approved', review_note: 'go', agent_id: a.id });
    expect(p.reviewer?.isEqual(w.id.admin)).toBe(true);
    expect(a).toMatchObject({ node_id: 1n, status: 'idle', protected: false });
    expect(a.owner.isEqual(w.id.admin)).toBe(true);
    expect([...w.h.db.config_history.iter()].filter(h => h.agent_id === a.id)).toHaveLength(1);
    const chans = [...w.h.db.member.iter()]
      .filter(m => m.member_kind === 'agent' && m.member_id === String(a.id))
      .map(m => w.h.db.channel.id.find(m.channel_id)!.name)
      .sort();
    expect(chans).toEqual(['capacity', 'general']);
  });

  it('reject only sets status, reviewer and note', () => {
    const w = setup();
    w.propose(AF('capacity'));
    w.call('admin', mod.review_agent, { id: 1n, approve: false, note: 'toolsmith covers it' });
    expect(w.h.db.agent_proposal.id.find(1n)).toMatchObject({ status: 'rejected', review_note: 'toolsmith covers it', agent_id: 0n });
    expect(w.h.db.agent.name.find('capacity')).toBeNull();
  });

  it('is admin-only and pending-only', () => {
    const w = setup();
    w.propose(AF('capacity'));
    expect(() => w.call('bob', mod.review_agent, { id: 1n, approve: true, note: '' })).toThrow(/only an admin/);
    expect(() => w.call('nodeA', mod.review_agent, { id: 1n, approve: true, note: '' })).toThrow(/only an admin/);
    w.call('admin', mod.review_agent, { id: 1n, approve: false, note: '' });
    expect(() => w.call('admin', mod.review_agent, { id: 1n, approve: true, note: '' })).toThrow(/already rejected/);
    expect(() => w.call('admin', mod.review_agent, { id: 9n, approve: true, note: '' })).toThrow(/no agent proposal 9/);
  });

  it('approve fails cleanly if the name was taken meanwhile', () => {
    const w = setup();
    w.propose(AF('capacity'));
    w.call('admin', mod.create_agent, { agentfile: AF('capacity'), node_id: 2n });
    expect(() => w.call('admin', mod.review_agent, { id: 1n, approve: true, note: '' })).toThrow(/already exists/);
    expect(w.h.db.agent_proposal.id.find(1n)?.status).toBe('pending');
  });
});
