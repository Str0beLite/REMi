// Joining a cluster (#83). Every machine runs the same `remi up`; the cluster's admin hands a new machine a join link
// (Config > Add a machine), and the new machine's own console pastes it into its onboarding.

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/;
const CONSOLE_PORT = '8080';

// The cluster console address other machines can reach, or '' if none is known. Machines are assumed to reach each
// other directly, so the address you opened this console with works for them too; only on localhost do we fall back to
// `workspace_url` (this machine's SpacetimeDB, stored by `remi up`), with the console's port.
export function clusterConsoleUrl(workspaceUrl: string, page: { origin: string; hostname: string }): string {
  if (!LOCAL.test(page.hostname)) return page.origin;
  if (!workspaceUrl.trim()) return '';
  const u = new URL(workspaceUrl.trim());
  u.port = CONSOLE_PORT;
  return u.origin;
}

export const joinLink = (console: string, db: string, code: string) => `${console}/?join=${code}&db=${db}`;

// ?join= on a console: someone opened a join link in a browser instead of pasting it into the new machine's onboarding.
export const readJoin = (search: string) => new URLSearchParams(search).get('join')?.trim() || undefined;

// The Swarm rail's "Add a machine" opens Config; this tells the panel to scroll itself into view once it mounts.
export const addMachineFocus = { pending: false };
