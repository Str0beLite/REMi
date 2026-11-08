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
export { AdaptersPanel } from './adapters/AdaptersPanel';
export { SleepPanel } from './sleep/SleepPanel';
export const ConfigPanel = () => <Stub title="Config" what="Nodes and settings arrive with #28." />;
