// "Get started" steps, read from live tables so they tick themselves off: a node is connected, the first REMi exists,
// and a REMi has replied in chat (the moment the product proves itself).
export type StepNode = { name: string; gpu: string; status: string };
export type StepAgent = { name: string; protected: boolean };
export type StepMessage = { authorKind: string; kind: string };

export type Step = { id: 'node' | 'remi' | 'hello'; done: boolean; text: string };

export function getStartedSteps(nodes: readonly StepNode[], agents: readonly StepAgent[], messages: readonly StepMessage[]): Step[] {
  const node = nodes.find(n => n.status !== 'down');
  const remi = agents.find(a => !a.protected); // Sleep REMi comes with the workspace; the first REMi is the team's own
  const replied = messages.some(m => m.authorKind === 'agent' && m.kind === 'chat');
  return [
    { id: 'node', done: !!node, text: node ? `${node.name} is connected (${node.gpu})` : 'Connect a GPU machine: run remi up on it' },
    { id: 'remi', done: !!remi, text: remi ? `You have a REMi: ${remi.name}` : 'Create your first REMi' },
    { id: 'hello', done: replied, text: replied ? 'A REMi replied' : `Say hi: mention @${remi?.name ?? 'its-name'} here` },
  ];
}
