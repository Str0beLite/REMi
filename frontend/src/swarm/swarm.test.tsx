import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SwarmRail } from './SwarmRail';
import { SAMPLE, activityByAgent, ago, equipmentOf, modelName, parseStats, skillLabel, slotLabel, trainingByNode } from './swarmData';

const html = (props: Parameters<typeof SwarmRail>[0]) => renderToStaticMarkup(<SwarmRail {...props} />);

describe('SwarmRail', () => {
  it('groups REMis under their node with name, status text and skills', () => {
    const out = html(SAMPLE);
    expect(out.match(/class="node is-/g)).toHaveLength(2);
    for (const a of SAMPLE.agents) {
      expect(out).toContain(a.name);
      expect(out).toContain(`remi-status status-${a.status}">${a.status}<`);
    }
    expect(out).toMatch(/oncall[^]*dc-ops v2/);
    expect(out).toMatch(/sleep-remi[^]*base model/);
  });

  it("draws a node's memory and LoRA slots from its stats, and says so when it has none", () => {
    const out = html(SAMPLE);
    expect(out).toContain('13.8 / 15.9 GB');
    expect(out).toContain('1/4');
    expect(out.match(/class="slot is-empty"/g)).toHaveLength(3);
    expect(out).toContain('no stats yet');
  });

  it('marks a stopped REMi, and shows the training line on the node that is training', () => {
    const out = html(SAMPLE);
    expect(out).toMatch(/remi-row is-stopped[^]*helpdesk/);
    expect(out).toContain('Training dc-ops-v4');
    expect(out).toContain('step 120');
  });

  it('keeps tools and activity out of the closed rows', () => {
    const out = html(SAMPLE);
    expect(out).not.toContain('/registry:host_power');
    expect(out).toContain('aria-expanded="false"');
  });

  it('explains how to add a node when the swarm is empty', () => {
    expect(html({ nodes: [], agents: [] })).toContain('remi up');
  });
});

describe('stats and skills', () => {
  it('parses node stats and rejects {} or malformed ones', () => {
    expect(parseStats('{}')).toBeUndefined();
    expect(parseStats('nope')).toBeUndefined();
    expect(parseStats('{"vram_total_mb":"x","vram_used_mb":1,"vram_vllm_mb":1,"lora_slots":4}')).toBeUndefined();
    expect(parseStats(SAMPLE.nodes[0].stats)).toMatchObject({ lora_slots: 4, loras: ['dc-ops@2'] });
  });

  it('names skills and slots in words', () => {
    expect(skillLabel([])).toBe('base model');
    expect(skillLabel([{ name: 'dc-ops', version: 2, weight: 1 }, { name: 'x', version: 1, weight: 0 }])).toBe('dc-ops v2');
    expect(skillLabel([{ name: 'dc-ops', version: 2, weight: 0.7 }, { name: 'net', version: 1, weight: 0.3 }])).toBe('dc-ops v2 70% + net v1 30%');
    expect(slotLabel('dc-ops@2', []).short).toBe('dc-ops v2');
    const capacity = { ...SAMPLE.agents[1], adapters: [{ name: 'dc-ops', version: 2, weight: 0.7 }, { name: 'net', version: 1, weight: 0.3 }] };
    expect(slotLabel('mix-150860105191', [capacity]).short).toBe('dc-ops + net');
    expect(slotLabel('mix-150860105191', []).short).toBe('mix 150860');
  });

  it('computes vLLM LoRA names exactly like remi.contract.model_name()', async () => {
    // reference values from the Python implementation
    expect(await modelName([])).toBeUndefined();
    expect(await modelName([{ name: 'dc-ops', version: 2, weight: 1 }, { name: 'x', version: 1, weight: 0 }])).toBe('dc-ops@2');
    expect(await modelName([{ name: 'dc-ops', version: 2, weight: 0.7 }, { name: 'net', version: 1, weight: 0.3 }])).toBe('mix-150860105191');
    expect(await modelName([{ name: 'net', version: 1, weight: 1 }, { name: 'dc-ops', version: 2, weight: 1 }])).toBe('mix-7eaedfa3bc61');
    expect(await modelName([{ name: 'a', version: 1, weight: 0.333 }])).toBe('mix-8c421cec26c7');
  });

  it("reads a REMi's adapters and tools from its Agentfile, leniently", () => {
    expect(equipmentOf('name: a\ntools: [say, sh]\nadapters:\n  - {name: dc-ops, version: 2, weight: 1}\n')).toEqual({
      tools: ['say', 'sh'],
      adapters: [{ name: 'dc-ops', version: 2, weight: 1 }],
    });
    expect(equipmentOf('name: [')).toEqual({ adapters: [], tools: [] });
  });
});

describe('SwarmRail: every agent, and what it is doing', () => {
  const channels = [{ id: 1n, name: '#general' }, { id: 2n, name: '#ops' }];

  it('lists REMis whose node is missing under "Not placed", even with no nodes', () => {
    const out = html({ nodes: [], agents: SAMPLE.agents });
    expect(out).toContain('Not placed');
    for (const a of SAMPLE.agents) expect(out).toContain(a.name);
  });

  it('shows status counts, the last action with its channel, and flags help requests', () => {
    const out = html({ ...SAMPLE, channels, onOpenChannel: () => {} });
    expect(out).toContain('1 needs help');
    expect(out).toContain('</i>1 thinking</span>');
    expect(out).toMatch(/remi-row needs-help[^]*toolsmith[^]*needs help/);
  });
});

describe('activityByAgent / ago', () => {
  it('labels the latest agent message by kind', () => {
    const m = (id: bigint, kind: string, meta = '{}') => ({ id, author_kind: 'agent', author_id: '7', kind, meta });
    expect(activityByAgent([m(1n, 'chat'), m(2n, 'tool_result', '{"command":"sh","exit_code":2}')]).get('7')?.label).toBe('sh failed (exit 2)');
    expect(activityByAgent([m(1n, 'help_request'), m(2n, 'chat')]).get('7')?.needsHelp).toBe(false);
    expect(ago(0, 30_000)).toBe('now');
    expect(ago(0, 3 * 3600_000)).toBe('3h');
  });
});

describe('trainingByNode', () => {
  it('uses only the latest sleep_event per node and ignores bad meta', () => {
    const agents = SAMPLE.agents;
    const msgs = [
      { id: 1n, author_kind: 'agent', author_id: '1', kind: 'sleep_event', meta: '{"phase":"training","spec":"a"}' },
      { id: 2n, author_kind: 'agent', author_id: '1', kind: 'sleep_event', meta: '{"phase":"wake"}' },
      { id: 3n, author_kind: 'agent', author_id: '3', kind: 'sleep_event', meta: 'not json' },
    ];
    expect(trainingByNode(msgs, agents).size).toBe(0);
    expect(trainingByNode(msgs.slice(0, 1), agents).get(1n)?.spec).toBe('a');
  });
});

describe('trainingByNode with system events', () => {
  it('maps system-authored training to the nodes that are asleep', () => {
    const nodes = [
      { id: 1n, name: 'gpu-01', gpu: 'x', status: 'asleep' },
      { id: 2n, name: 'gpu-02', gpu: 'x', status: 'up' },
    ];
    const msgs = [{ id: 5n, author_kind: 'system', author_id: 'system', kind: 'sleep_event', meta: '{"phase":"training","spec":"dc-ops","step":40}' }];
    const t = trainingByNode(msgs, SAMPLE.agents, nodes);
    expect(t.get(1n)).toEqual({ spec: 'dc-ops', step: 40 });
    expect(t.has(2n)).toBe(false);
  });
});
