// MCP servers agents may call (CONTRACT.md §4 set_mcp_server, remove_mcp_server; #72). The URL and headers (API keys)
// go only to the private mcp_server_secret table; the public mcp_server row shows the name, host and who added it.
import { SenderError, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import db from '../contract';

const NAME = /^[a-z0-9-]{2,32}$/;
const URL_HOST = /^https:\/\/(?:[^@/?#\s]*@)?([^/?#:@\s]+)[^\s]*$/; // remote servers only; group 1 is the host

type Ctx = ReducerCtx<InferSchema<typeof db>>;

function admin(ctx: Ctx) {
  const me = ctx.db.user.identity.find(ctx.sender);
  if (me?.is_admin !== true) throw new SenderError('only an admin can change MCP servers');
  return me;
}

export const set_mcp_server = db.reducer(
  { name: t.string(), url: t.string(), headers: t.string() },
  (ctx, { name, url, headers }) => {
    const me = admin(ctx);
    if (!NAME.test(name)) throw new SenderError('server names are 2-32 characters of a-z, 0-9 and -');
    const host = url.length <= 2000 ? URL_HOST.exec(url)?.[1] : undefined;
    if (!host) throw new SenderError('the URL must be an https:// address (at most 2000 characters)');
    if (headers.length > 4000) throw new SenderError('headers are at most 4000 characters');
    let parsed: unknown;
    try {
      parsed = JSON.parse(headers);
    } catch {
      throw new SenderError('headers must be a JSON object');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.values(parsed).some(v => typeof v !== 'string'))
      throw new SenderError('headers must be a JSON object of strings, like {"x-api-key": "..."}');
    const row = { name, host, added_by: me.nickname, updated_at: ctx.timestamp };
    if (ctx.db.mcp_server.name.find(name)) ctx.db.mcp_server.name.update(row);
    else ctx.db.mcp_server.insert(row);
    if (ctx.db.mcp_server_secret.name.find(name)) ctx.db.mcp_server_secret.name.update({ name, url, headers });
    else ctx.db.mcp_server_secret.insert({ name, url, headers });
  },
);

export const remove_mcp_server = db.reducer({ name: t.string() }, (ctx, { name }) => {
  admin(ctx);
  if (!ctx.db.mcp_server.name.find(name)) throw new SenderError(`no MCP server named ${name}`);
  ctx.db.mcp_server.name.delete(name);
  ctx.db.mcp_server_secret.name.delete(name);
});
