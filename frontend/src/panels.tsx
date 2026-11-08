// Panel slots. #12 (agents), #13 (tools), #14 (adapters, sleep) and #28 (config) each replace one stub.

function Stub({ title, what }: { title: string; what: string }) {
  return (
    <section className="panel-stub">
      <h1>{title}</h1>
      <p>{what}</p>
    </section>
  );
}

export { AgentsPanel } from './agents/AgentsPanel';
export { ToolsPanel } from './tools/ToolsPanel';
export const AdaptersPanel = () => <Stub title="Adapters" what="Adapter versions, weights and rollback arrive with #14." />;
export const SleepPanel = () => <Stub title="Sleep" what="The live loss chart and wake report arrive with #14." />;
export const ConfigPanel = () => <Stub title="Config" what="Nodes and settings arrive with #28." />;
