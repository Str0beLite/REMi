import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Identity, Timestamp } from 'spacetimedb';
import type { AgentProposal } from '../../module_bindings/types';
import { AgentCardView } from './AgentCard';
import { proposalIdOf } from './cardMeta';

const AF = 'name: capacity\npurpose: Answers rack capacity questions\nchannels: [general, capacity]\ntriggers: [mention]\ntools: [say, "registry:host_power"]\nbudget: {turns: 5, minutes: 5}\nadapters: []\n';

const proposal = (over: Partial<AgentProposal> = {}): AgentProposal => ({
  id: 7n,
  agentfile: AF,
  nodeId: 1n,
  authorAgent: 1n,
  reason: 'Capacity questions keep coming up',
  status: 'pending',
  reviewer: undefined,
  reviewNote: '',
  agentId: 0n,
  ts: Timestamp.now(),
  ...over,
});

const render = (p: AgentProposal, isAdmin: boolean, reviewer?: string) =>
  renderToStaticMarkup(<AgentCardView p={p} author="toolsmith" reviewer={reviewer} isAdmin={isAdmin} onDecide={vi.fn()} />);

describe('AgentCardView', () => {
  it("renders the Agentfile fields, the status and the author's reason", () => {
    const html = render(proposal(), false);
    for (const s of ['capacity', 'Answers rack capacity questions', 'say, registry:host_power', '#general, #capacity', 'pending', 'Proposed by toolsmith', 'Capacity questions keep coming up'])
      expect(html).toContain(s);
  });

  it('shows Approve / Reject with a note field to admins on a pending proposal', () => {
    const html = render(proposal(), true);
    expect(html).toMatch(/>Approve</);
    expect(html).toMatch(/>Reject</);
    expect(html).toContain('<textarea');
  });

  it('shows non-admins the status only', () => {
    const html = render(proposal(), false);
    expect(html).not.toMatch(/>Approve</);
    expect(html).not.toContain('<textarea');
    expect(html).toContain('Waiting for an admin');
  });

  it('shows the outcome and note once reviewed, with no buttons even for admins', () => {
    const html = render(proposal({ status: 'rejected', reviewer: Identity.zero(), reviewNote: 'toolsmith covers it' }), true, 'ryan');
    expect(html).toContain('Rejected by ryan: “toolsmith covers it”');
    expect(html).not.toMatch(/>Approve</);
  });

  it('survives an unreadable Agentfile', () => {
    expect(render(proposal({ agentfile: 'name: [' }), false)).toContain('unreadable Agentfile');
  });
});

describe('proposalIdOf', () => {
  it('reads the agent_card meta', () => {
    expect(proposalIdOf('{"proposal_id": 7}')).toBe(7n);
    expect(proposalIdOf('{}')).toBeUndefined();
    expect(proposalIdOf('nope')).toBeUndefined();
  });
});
