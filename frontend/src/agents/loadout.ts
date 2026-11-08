import type { BUILTIN_TOOLS } from './agentfile';

// Tile copy for the editor's loadout: one icon and one line per built-in (CONTRACT.md §7).
export const LOADOUT: Record<(typeof BUILTIN_TOOLS)[number], { icon: string; title: string; does: string }> = {
  sh: { icon: '⌨️', title: 'Terminal', does: 'Runs shell commands in its own sandbox' },
  fetch: { icon: '🌐', title: 'Web reader', does: 'Reads a web page' },
  say: { icon: '💬', title: 'Messenger', does: 'Posts in another channel or pings someone' },
  note: { icon: '📝', title: 'Notebook', does: 'Remembers something for later' },
  send: { icon: '📦', title: 'File courier', does: 'Hands a file to another REMi' },
  migrate: { icon: '🧳', title: 'Mover', does: 'Moves REMis between machines' },
  agents: { icon: '👥', title: 'Team view', does: 'Sees, stops and starts other REMis' },
  propose_tool: { icon: '🛠️', title: 'Tool maker', does: 'Writes new tools for review' },
  'registry:*': { icon: '🧰', title: 'Toolbox', does: 'Every tool the team has approved' },
};
