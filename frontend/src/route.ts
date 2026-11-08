// The view and channel live in the URL hash (#/chat/12, #/agents/12), so reload, back/forward and links keep your place.
export const PANEL_IDS = ['chat', 'agents', 'tools', 'adapters', 'sleep', 'config'] as const;
export type PanelId = (typeof PANEL_IDS)[number];
export type Route = { panel: PanelId; channelId?: bigint };

export function readRoute(hash: string): Route {
  const [p, c] = hash.replace(/^#\/?/, '').split('/');
  const panel = (PANEL_IDS as readonly string[]).includes(p) ? (p as PanelId) : 'chat';
  return { panel, channelId: c && /^\d+$/.test(c) ? BigInt(c) : undefined };
}

export const writeRoute = (r: Route) => `#/${r.panel}${r.channelId !== undefined ? `/${r.channelId}` : ''}`;
