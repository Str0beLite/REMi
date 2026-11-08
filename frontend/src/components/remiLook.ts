// Types and fallback look for RemiAvatar (kept out of the component file for React fast refresh).

export type AgentStatus = 'idle' | 'thinking' | 'asleep' | 'stopped';
export type Headgear = 'none' | 'nightcap' | 'headset' | 'hardhat' | 'bow';

export const HEADGEAR: readonly Headgear[] = ['none', 'nightcap', 'headset', 'hardhat', 'bow'];
export const AGENT_STATUSES: readonly AgentStatus[] = ['idle', 'thinking', 'asleep', 'stopped'];
export const TINTS = ['#6d74c9', '#3e9c8f', '#e2a93b', '#d9668e', '#8e82b0', '#5b8db8'];

// Fallback look until the Agentfile carries `look` (#46): protected agents (Sleep REMi) get the nightcap.
export function defaultLook(agent: { name: string; protected: boolean }): { headgear: Headgear; tint: string } {
  let h = 0;
  for (const ch of agent.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { headgear: agent.protected ? 'nightcap' : 'none', tint: agent.protected ? TINTS[0] : TINTS[h % TINTS.length] };
}
