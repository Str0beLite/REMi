// Agent proposals: CONTRACT.md §4 propose_agent, review_agent. Mirrors propose_tool/review_tool:
// a REMi proposes, an admin approves, and approval creates the agent exactly like create_agent.
import { SenderError, t } from 'spacetimedb/server';
import db, { SLEEP_TOOLS } from '../contract';
import { parseAgentfile } from '../agentfile';
import { insertAgent, type Ctx } from '../agentOps';

const MAX_REASON = 2_000;

const isAdmin = (ctx: Ctx) => ctx.db.user.identity.find(ctx.sender)?.is_admin === true;

// Guardrail: a REMi can only hand out tools it has itself. `registry:*` covers any single registry tool.
function toolAllowed(tool: string, authorTools: readonly string[]) {
  if (authorTools.includes(tool)) return true;
  return tool.startsWith('registry:') && tool !== 'registry:*' && authorTools.includes('registry:*');
}

export const propose_agent = db.reducer(
  { agentfile: t.string(), author_agent: t.u64(), reason: t.string() },
  (ctx, { agentfile, author_agent, reason }) => {
    const author = ctx.db.agent.id.find(author_agent);
    if (!author) throw new SenderError(`no agent ${author_agent}`);
    if (ctx.db.node.identity.find(ctx.sender)?.id !== author.node_id)
      throw new SenderError(`only agent ${author_agent}'s node can propose for it`);
    if (!reason.trim()) throw new SenderError('give a reason for the new agent');
    if (reason.length > MAX_REASON) throw new SenderError(`reason is over ${MAX_REASON} characters`);

    const af = parseAgentfile(agentfile);
    if (ctx.db.agent.name.find(af.name)) throw new SenderError(`an agent named ${af.name} already exists`);
    if ([...ctx.db.agent_proposal.iter()].some(p => p.status === 'pending' && parseAgentfile(p.agentfile).name === af.name))
      throw new SenderError(`a pending proposal already uses the name ${af.name}`);
    const sleepTools = af.tools.filter(x => (SLEEP_TOOLS as readonly string[]).includes(x));
    if (sleepTools.length) throw new SenderError(`proposed agents can't have Sleep REMi commands: ${sleepTools.join(', ')}`);
    const authorTools = parseAgentfile(author.agentfile).tools;
    const extra = af.tools.filter(x => !toolAllowed(x, authorTools));
    if (extra.length) throw new SenderError(`${author.name} can't give tools it doesn't have: ${extra.join(', ')}`);
    if (af.adapters.length) throw new SenderError('proposed agents start on the base model: adapters must be []');

    ctx.db.agent_proposal.insert({
      id: 0n,
      agentfile,
      node_id: author.node_id,
      author_agent,
      reason,
      status: 'pending',
      reviewer: undefined,
      review_note: '',
      agent_id: 0n,
      ts: ctx.timestamp,
    });
  },
);

export const review_agent = db.reducer({ id: t.u64(), approve: t.bool(), note: t.string() }, (ctx, { id, approve, note }) => {
  if (!isAdmin(ctx)) throw new SenderError('only an admin can review agent proposals');
  const p = ctx.db.agent_proposal.id.find(id);
  if (!p) throw new SenderError(`no agent proposal ${id}`);
  if (p.status !== 'pending') throw new SenderError(`proposal ${id} was already ${p.status}`);
  let agentId = 0n;
  if (approve) {
    if (!ctx.db.node.id.find(p.node_id)) throw new SenderError(`node ${p.node_id} no longer exists`);
    agentId = insertAgent(ctx, parseAgentfile(p.agentfile), p.agentfile, p.node_id, ctx.sender).id;
  }
  ctx.db.agent_proposal.id.update({
    ...p,
    status: approve ? 'approved' : 'rejected',
    reviewer: ctx.sender,
    review_note: note,
    agent_id: agentId,
  });
});
