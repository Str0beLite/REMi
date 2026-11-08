import { toolMeta, type ToolStep } from './model';

const firstLine = (s = '') => s.split('\n')[0] || '(empty)';
const duration = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// A run of tool calls from one agent as one collapsed block: "3 tool calls · sh, curl · 1 failed".
// Opening it lists each call with its result; each step opens to the full command and output.
export function ToolRun({ steps }: { steps: ToolStep[] }) {
  const metas = steps.map(s => ({ ...toolMeta(s.call), ...toolMeta(s.result) }));
  const failed = steps.filter((s, i) => s.result && (metas[i].exit_code ?? 0) !== 0).length;
  const running = !!steps.at(-1)?.call && !steps.at(-1)?.result;
  const commands = [...new Set(metas.map((m, i) => m.command ?? firstLine(steps[i].call?.body).split(' ')[0]))];
  return (
    <details className="tool-run">
      <summary>
        <span className="tool-run-count">
          {steps.length} tool {steps.length === 1 ? 'call' : 'calls'}
        </span>
        <code className="tool-run-cmds">{commands.join(', ')}</code>
        {failed > 0 && <span className="tool-run-failed">{failed} failed</span>}
        {running && <span className="tool-run-running">running…</span>}
      </summary>
      <ol className="tool-steps">
        {steps.map((s, i) => {
          const meta = metas[i];
          const state = !s.result ? 'running' : (meta.exit_code ?? 0) !== 0 ? `exit ${meta.exit_code}` : 'ok';
          return (
            <li key={String((s.call ?? s.result)!.id)}>
              <details className="tool-step">
                <summary>
                  <span className={`tool-step-state${state === 'ok' ? '' : state === 'running' ? ' is-running' : ' is-failed'}`}>{state}</span>
                  <code>{s.call ? firstLine(s.call.body) : (meta.command ?? 'result')}</code>
                  {meta.ms !== undefined && <span className="tool-step-ms mono">{duration(meta.ms)}</span>}
                </summary>
                {s.call && <pre aria-label="Command">{s.call.body}</pre>}
                {s.result && <pre aria-label="Output">{s.result.body || '(no output)'}</pre>}
              </details>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
