import type { BUILTIN_TOOLS } from './agentfile';

// Tile copy for the editor's loadout: one icon and one line per built-in (CONTRACT.md §7).
export const LOADOUT: Record<(typeof BUILTIN_TOOLS)[number], { icon: string; name: string; does: string }> = {
  sh: { icon: '⌨️', name: '/sh', does: 'Runs shell commands in its own sandbox' },
  fetch: { icon: '🌐', name: '/fetch', does: 'Reads a web page' },
  say: { icon: '💬', name: '/say', does: 'Posts in another channel or pings someone' },
  note: { icon: '📝', name: '/note', does: 'Remembers something for later' },
  send: { icon: '📦', name: '/send', does: 'Hands a file to another REMi' },
  migrate: { icon: '🧳', name: '/migrate', does: 'Moves REMis between machines' },
  agents: { icon: '👥', name: '/agents', does: 'Sees, stops and starts other REMis' },
  propose_tool: { icon: '🛠️', name: '/propose_tool', does: 'Writes new tools for review' },
  'registry:*': { icon: '🧰', name: 'Toolbox', does: 'Every tool the team has approved' },
};
