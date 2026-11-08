import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SwarmRail } from './SwarmRail';
import { SAMPLE, trainingByNode, type SwarmAgent } from './swarmData';

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
