// What the Add a machine panel shows (#83): the address other machines use, and the one command to run on them.

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/;

// The SpacetimeDB base URL another machine can reach, or '' if none is known. Machines are assumed to reach each other
// directly, so the address you opened the console with works for them too; only on localhost do we fall back to
// `workspace_url`, which `remi up --lan` stores.
export function workspaceUrl(setting: string, stdbUri: string): string {
  const u = new URL(stdbUri.replace(/^ws/, 'http'));
  if (!LOCAL.test(u.hostname)) return u.origin;
  return setting.trim().replace(/\/+$/, '');
}

export const joinCommand = (url: string, db: string, code: string) =>
  `git clone https://github.com/Str0beLite/REMi && cd REMi && scripts/remi join ${url}/${db} ${code}`;

// 24 URL-safe characters: inside set_node_join_code's [A-Za-z0-9_-]{16,64}.
export function newJoinCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

// The Swarm rail's "Add a machine" opens Config; this tells the panel to scroll itself into view once it mounts.
export const addMachineFocus = { pending: false };
