// Module entry point (lane:web). Reducers from CONTRACT.md §4 go here, built against src/contract.ts.
import db, { DEFAULT_CHANNELS, DEFAULT_SETTINGS } from './contract';

export default db;
export * from './reducers/chat';
export * from './reducers/work';
export * from './reducers/agents';
export * from './reducers/adapters';
export * from './reducers/sleep';
export * from './reducers/proposals';
export * from './reducers/admin';
export * from './reducers/mcp';
export * from './reducers/nodes';
export * from './reducers/files';

export const init = db.init(ctx => {
  for (const name of DEFAULT_CHANNELS) {
    ctx.db.channel.insert({
      id: 0n,
      name,
      kind: 'public',
      parent_id: 0n,
      created_by: ctx.sender,
      ts: ctx.timestamp,
    });
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) ctx.db.setting.insert({ key, value });
  // ctx.sender here is the identity that published the database: the workspace owner is its first admin.
  ctx.db.user.insert({ identity: ctx.sender, nickname: 'owner', is_admin: true });
});
