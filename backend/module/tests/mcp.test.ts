import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import db from '../src/contract';

let conn = 1n;
const auth = (sub: string) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(conn++));
const URL = 'https://backend.composio.dev/v3/mcp/abc/mcp?user_id=ws';
const KEY = '{"x-api-key":"k1"}';

function setup() {
  const h = createModuleTestHarness(db, mod);
  const as = { owner: auth('owner'), bob: auth('bob') };
  h.withReducerTx(as.owner, ctx => mod.init(ctx as never, {}));
  h.withReducerTx(as.bob, ctx => mod.set_nickname(ctx as never, { nickname: 'bob' }));
  const call = <A>(who: keyof typeof as, fn: (ctx: never, args: A) => void, args: A) => h.withReducerTx(as[who], ctx => fn(ctx as never, args));
  return { h, call };
}

describe('set_mcp_server', () => {
  it('is admin-only and validates name, URL and headers', () => {
    const w = setup();
    const set = (name: string, url = URL, headers = KEY) => () => w.call('owner', mod.set_mcp_server, { name, url, headers });
    expect(() => w.call('bob', mod.set_mcp_server, { name: 'composio', url: URL, headers: KEY })).toThrow(/only an admin/);
    expect(set('Composio')).toThrow(/server names/);
    expect(set('c')).toThrow(/server names/);
    expect(set('composio', 'http://example.com/mcp')).toThrow(/https/);
    expect(set('composio', 'https://')).toThrow(/https/);
    expect(set('composio', 'https://x.dev/' + 'a'.repeat(2000))).toThrow(/https/);
    expect(set('composio', URL, 'nope')).toThrow(/JSON object/);
    expect(set('composio', URL, '["x"]')).toThrow(/JSON object/);
    expect(set('composio', URL, '{"n": 1}')).toThrow(/strings/);
    expect(set('composio', URL, JSON.stringify({ k: 'v'.repeat(4000) }))).toThrow(/4000/);
    expect(w.h.db.mcp_server.count()).toBe(0n);
  });

  it('upserts the public row and the private secret', () => {
    const w = setup();
    w.call('owner', mod.set_mcp_server, { name: 'composio', url: URL, headers: KEY });
    expect(w.h.db.mcp_server.name.find('composio')).toMatchObject({ host: 'backend.composio.dev', added_by: 'owner' });
    expect(w.h.db.mcp_server_secret.name.find('composio')).toEqual({ name: 'composio', url: URL, headers: KEY });
    w.call('owner', mod.set_mcp_server, { name: 'composio', url: 'https://other.dev/mcp', headers: '{}' });
    expect(w.h.db.mcp_server.count()).toBe(1n);
    expect(w.h.db.mcp_server.name.find('composio')?.host).toBe('other.dev');
    expect(w.h.db.mcp_server_secret.name.find('composio')?.headers).toBe('{}');
  });
});

describe('remove_mcp_server', () => {
  it('is admin-only and deletes both rows', () => {
    const w = setup();
    w.call('owner', mod.set_mcp_server, { name: 'composio', url: URL, headers: KEY });
    expect(() => w.call('bob', mod.remove_mcp_server, { name: 'composio' })).toThrow(/only an admin/);
    w.call('owner', mod.remove_mcp_server, { name: 'composio' });
    expect(w.h.db.mcp_server.count()).toBe(0n);
    expect(w.h.db.mcp_server_secret.count()).toBe(0n);
    expect(() => w.call('owner', mod.remove_mcp_server, { name: 'composio' })).toThrow(/no MCP server/);
  });
});
