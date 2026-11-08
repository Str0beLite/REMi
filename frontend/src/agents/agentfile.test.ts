import { describe, expect, it } from 'vitest';
import { BLANK, TEMPLATES, checkAgentfile, toYaml } from './agentfile';

const invalid = Object.entries(
  import.meta.glob('../../../fixtures/agentfiles/invalid/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
);

describe('checkAgentfile', () => {
  it.each(TEMPLATES.map(t => [t.id, t.text]))('accepts template %s', (_id, text) => {
    expect(checkAgentfile(text).ok).toBe(true);
  });

  it('has invalid fixtures to check', () => expect(invalid.length).toBeGreaterThan(0));

  it.each(invalid)('rejects %s with a readable error', (_f, text) => {
    const r = checkAgentfile(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });

  it('reports YAML syntax errors separately from schema errors', () => {
    const r = checkAgentfile('name: [');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/^YAML:/);
  });

  it('round-trips the form model through YAML', () => {
    const r = checkAgentfile(toYaml({ ...BLANK, name: 'oncall', tools: ['sh', 'registry:host_power'] }));
    expect(r.ok && r.value.tools).toEqual(['sh', 'registry:host_power']);
  });

  it('ships the fixture templates', () => {
    expect(TEMPLATES.map(t => t.id)).toEqual(expect.arrayContaining(['blank', 'homelab-remi', 'sleep-remi', 'tool-builder']));
  });
});
