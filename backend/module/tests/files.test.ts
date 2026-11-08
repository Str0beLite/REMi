import { ConnectionId, Identity, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import db from '../src/contract';

let conn = 1n;
const auth = (sub: string) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(conn++));
const AF = (name: string) => `name: ${name}\npurpose: test\nchannels: [general]\ntriggers: [mention]\ntools: [say]\nbudget: {turns: 5, minutes: 5}\nadapters: []\n`;

// Console uploads and sandbox browsing (#98). helper (1) runs on node a and belongs to bob; carol is a plain member;
// stranger has no user row.
function setup() {
  const h = createModuleTestHarness(db, mod);
  const as = { admin: auth('admin'), bob: auth('bob'), carol: auth('carol'), stranger: auth('x'), nodeA: auth('a'), nodeB: auth('b') };
  const id = Object.fromEntries(Object.entries(as).map(([k, a]) => [k, h.withReducerTx(a, ctx => ctx.sender)])) as Record<keyof typeof as, Identity>;
  h.withReducerTx(TestAuth.internal(), ctx => {
    mod.init(ctx, {});
    ctx.db.user.insert({ identity: id.admin, nickname: 'ryan', is_admin: true });
    ctx.db.user.insert({ identity: id.bob, nickname: 'bob', is_admin: false });
    ctx.db.user.insert({ identity: id.carol, nickname: 'carol', is_admin: false });
    const node = (identity: Identity, name: string) =>
      ctx.db.node.insert({ id: 0n, identity, name, gpu: 'x', base_model: 'm', status: 'up', last_seen: ctx.timestamp, stats: '{}' });
    const a = node(id.nodeA, 'a');
    node(id.nodeB, 'b');
    ctx.db.agent.insert({ id: 0n, name: 'helper', agentfile: AF('helper'), status: 'idle', node_id: a.id, owner: id.bob, protected: false });
  });
  const call = <A>(who: keyof typeof as, fn: (ctx: never, args: A) => void, args: A) => h.withReducerTx(as[who], ctx => fn(ctx as never, args));
  const last = () => [...h.db.message.iter()].at(-1)!.body;
  return { h, call, last, id };
}

const HELPER = 1n, GENERAL = 1n;
const upload = { blob: 'file:n1:notes.txt', name: 'notes.txt', size: 5n, sha256: '', chunks: 1, from_agent: 0n, to_agent: HELPER, channel_id: GENERAL, note: '' };

describe('console uploads', () => {
  it('any member uploads chunks and sends; the delivery line names them', () => {
    const w = setup();
    expect(() => w.call('stranger', mod.put_blob_chunk, { blob: 'file:n1:notes.txt', seq: 0, data: 'aGVsbG8=' })).toThrow(/member/);
    expect(() => w.call('carol', mod.put_blob_chunk, { blob: 'mig:1:x@1', seq: 0, data: '' })).toThrow(/member uploading a file/);
    w.call('carol', mod.put_blob_chunk, { blob: 'file:n1:notes.txt', seq: 0, data: 'aGVsbG8=' });
    expect(() => w.call('stranger', mod.send_file, upload)).toThrow(/workspace member/);
    expect(() => w.call('carol', mod.send_file, { ...upload, chunks: 2 })).toThrow(/chunk 1/);
    expect(() => w.call('carol', mod.send_file, { ...upload, size: 52_428_801n })).toThrow(/50 MB/);
    w.call('carol', mod.send_file, upload);
    expect(w.h.db.file_transfer.id.find(1n)).toMatchObject({ from_agent: 0n, from_user: w.id.carol.toHexString(), state: 'sent' });
    w.call('nodeA', mod.file_delivered, { id: 1n });
    expect(w.last()).toBe('@helper carol sent you /shared/notes.txt (5 B)');
  });

  it('a failed upload mentions the uploader', () => {
    const w = setup();
    w.call('bob', mod.put_blob_chunk, { blob: 'file:n1:notes.txt', seq: 0, data: 'aGVsbG8=' });
    w.call('bob', mod.send_file, upload);
    w.call('nodeA', mod.file_failed, { id: 1n, note: 'disk full' });
    expect(w.last()).toBe('@bob sending notes.txt to helper failed: disk full');
  });

  it('/send from an agent still needs its node and leaves from_user empty', () => {
    const w = setup();
    w.call('nodeB', mod.put_blob_chunk, { blob: 'file:n2:x', seq: 0, data: '' });
    expect(() => w.call('carol', mod.send_file, { ...upload, blob: 'file:n2:x', from_agent: 1n, to_agent: 1n })).toThrow(/helper's node/);
  });
});

describe("fs_ask / fs_answer", () => {
  it('owner or admin asks with a safe path; others and bad paths are refused', () => {
    const w = setup();
    expect(() => w.call('carol', mod.fs_ask, { agent_id: HELPER, op: 'list', path: '/workspace' })).toThrow(/owner or an admin/);
    expect(() => w.call('bob', mod.fs_ask, { agent_id: HELPER, op: 'write', path: '/workspace' })).toThrow(/op is one of/);
    for (const path of ['/etc/passwd', 'workspace', '/workspacex', '/workspace/../etc', '/shared/a/../../x', '/workspace/\0'])
      expect(() => w.call('bob', mod.fs_ask, { agent_id: HELPER, op: 'read', path })).toThrow(/paths/);
    w.call('bob', mod.fs_ask, { agent_id: HELPER, op: 'list', path: '/workspace' });
    w.call('admin', mod.fs_ask, { agent_id: HELPER, op: 'read', path: '/shared/notes.txt' });
    expect(w.h.db.fs_request.id.find(1n)).toMatchObject({ requested_by: w.id.bob, op: 'list', state: 'pending', result: '' });
    expect(w.h.db.fs_request.id.find(2n)?.requested_by.isEqual(w.id.admin)).toBe(true);
  });

  it("only the agent's node answers, once", () => {
    const w = setup();
    w.call('bob', mod.fs_ask, { agent_id: HELPER, op: 'list', path: '/workspace' });
    expect(() => w.call('nodeB', mod.fs_answer, { id: 1n, ok: true, result: '{}' })).toThrow(/agent's node/);
    expect(() => w.call('bob', mod.fs_answer, { id: 1n, ok: true, result: '{}' })).toThrow(/agent's node/);
    expect(() => w.call('nodeA', mod.fs_answer, { id: 1n, ok: true, result: 'x'.repeat(1_500_001) })).toThrow(/at most/);
    w.call('nodeA', mod.fs_answer, { id: 1n, ok: false, result: 'no sandbox yet' });
    expect(w.h.db.fs_request.id.find(1n)).toMatchObject({ state: 'failed', result: 'no sandbox yet' });
    expect(() => w.call('nodeA', mod.fs_answer, { id: 1n, ok: true, result: '{}' })).toThrow(/is failed/);
  });

  it('a new request deletes rows older than 10 minutes', () => {
    const w = setup();
    w.h.withReducerTx(TestAuth.internal(), ctx =>
      ctx.db.fs_request.insert({ id: 0n, agent_id: HELPER, requested_by: w.id.bob, op: 'list', path: '/shared', state: 'done', result: '{}', ts: new Timestamp(0n) }),
    );
    w.h.clock.set(new Timestamp(11n * 60n * 1_000_000n));
    w.call('bob', mod.fs_ask, { agent_id: HELPER, op: 'list', path: '/workspace' });
    expect([...w.h.db.fs_request.iter()].map(r => r.path)).toEqual(['/workspace']);
  });
});
