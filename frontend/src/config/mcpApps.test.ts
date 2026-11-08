import { describe, expect, it } from 'vitest';
import { checkAgentfile, toYaml, BLANK } from '../agents/agentfile';
import { mcpTile } from './mcpApps';

describe('mcpTile', () => {
  it('gives each server a tile whose id is a valid Agentfile mcp: tool', () => {
    for (const s of [{ name: 'composio', host: 'connect.composio.dev' }, { name: 'my-server', host: 'x.example' }]) {
      const t = mcpTile(s);
      expect(t.id).toBe(`mcp:${s.name}/*`);
      expect(checkAgentfile(toYaml({ ...BLANK, tools: [t.id] })).ok).toBe(true);
    }
    expect(mcpTile({ name: 'composio', host: '' }).title).toBe('Composio apps');
  });
});
