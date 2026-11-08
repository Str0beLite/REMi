// Module entry point (lane:web). Reducers from CONTRACT.md §4 go here, built against src/contract.ts.
import db, { DEFAULT_CHANNELS, DEFAULT_SETTINGS } from './contract';

export default db;

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
});
