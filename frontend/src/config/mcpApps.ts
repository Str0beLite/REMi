// Composio's MCP endpoint and key header, as proven end to end in #74.
export const COMPOSIO = { name: 'composio', url: 'https://connect.composio.dev/mcp', header: 'x-consumer-api-key' };

// How a connected MCP server shows up as a tile in the agent editor's backpack; the tile adds mcp:<server>/*.
export function mcpTile(server: { name: string; host: string }): { id: string; icon: string; title: string; does: string } {
  const id = `mcp:${server.name}/*`;
  return server.name === COMPOSIO.name
    ? { id, icon: '🧩', title: 'Composio apps', does: 'Gmail, GitHub, Slack and 500+ more' }
    : { id, icon: '🔌', title: server.name, does: `Every tool on ${server.host}` };
}
