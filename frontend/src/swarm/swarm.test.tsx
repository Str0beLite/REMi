import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SwarmRail } from './SwarmRail';
import { SAMPLE, activityByAgent, ago, trainingByNode, type SwarmAgent } from './swarmData';

const html = (props: Parameters<typeof SwarmRail>[0]) => renderToStaticMarkup(<SwarmRail {...props} />);

describe('SwarmRail', () => {
  it('draws one 8U rack per node with each REMi as a plate showing name, purpose and status text', () => {
    const out = html(SAMPLE);
    expect(out.match(/class="rack"/g)).toHaveLength(2);
    expect(out).toContain('gpu-01: 4 of 8U used');
    for (const a of SAMPLE.agents) {
      expect(out).toContain(`<b>${a.name}</b>`);
      expect(out).toContain(a.purpose);
      expect(out).toContain(`status-${a.status}">${a.status}<`);
    }
    expect(out).toContain('>U8<');
    expect(out).toContain('>U1<');
  });

  it('prints a stopped REMi grey', () => {
    expect(html(SAMPLE)).toMatch(/rack-plate is-stopped[^]*helpdesk/);
  });

  it('shows a training band on the node whose latest sleep_event is training, free slots elsewhere', () => {
    const out = html(SAMPLE);
    expect(out).toContain('rack-band');
    expect(out).toContain('dc-ops-v4');
    expect(out).toContain('step 120');
    expect(out).toContain('4U free');
  });

  it('grows the rack past 8U when more than four REMis share a node', () => {
    const agents: SwarmAgent[] = Array.from({ length: 5 }, (_, i) => ({
      id: BigInt(i + 1), name: `r${i}`, status: 'idle', node_id: 1n, purpose: 'p', protected: false,
    }));
    expect(html({ nodes: [SAMPLE.nodes[0]], agents })).toContain('gpu-01: 10 of 10U used');
  });

  it('explains how to add a node when the swarm is empty', () => {
    expect(html({ nodes: [], agents: [] })).toContain('remi up');
  });
});

describe('SwarmRail: every agent, and what it is doing', () => {
  const channels = [{ id: 1n, name: '#general' }, { id: 2n, name: '#ops' }];

  it('lists REMis whose node is missing under "Not placed", even with no nodes', () => {
    const out = html({ nodes: [], agents: SAMPLE.agents });
    expect(out).toContain('Not placed');
    for (const a of SAMPLE.agents) expect(out).toContain(`<b>${a.name}</b>`);
  });

  it('shows status counts, the last action with its channel, and flags help requests', () => {
    const out = html({ ...SAMPLE, channels, onOpenChannel: () => {} });
    expect(out).toContain('1 needs help');
    expect(out).toContain('</i>1 thinking</span>');
    expect(out).toContain('ran ipmitool');
    expect(out).toContain('ran ipmitool in #ops');
    expect(out).toMatch(/rack-plate needs-help[^]*toolsmith/);
    expect(out).toContain('title="Open #ops"');
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
