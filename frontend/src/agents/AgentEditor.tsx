import { useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { BUILTIN_TOOLS, TEMPLATES, TRIGGERS, checkAgentfile, toYaml, type Agentfile } from './agentfile';

type Props = {
  mode: 'create' | 'edit';
  initialText: string;
  nodes?: readonly { id: bigint; name: string }[];
  readOnlyReason?: string;
  onSubmit: (text: string, nodeId?: bigint) => Promise<void>;
  onCancel?: () => void;
};

const list = (s: string) =>
  s
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

// Form and YAML edit the same Agentfile text; the schema check runs on every keystroke.
export function AgentEditor({ mode, initialText, nodes = [], readOnlyReason, onSubmit, onCancel }: Props) {
  const uid = useId();
  const [text, setText] = useState(initialText);
  const [tab, setTab] = useState<'form' | 'yaml'>('form');
  const [nodeId, setNodeId] = useState<bigint | undefined>(nodes[0]?.id);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const checked = useMemo(() => checkAgentfile(text), [text]);
  const af = checked.ok ? checked.value : undefined;
  const readOnly = !!readOnlyReason;

  const update = (patch: Partial<Agentfile>) => af && setText(toYaml({ ...af, ...patch }));
  const registry = af ? af.tools.filter(t => t.startsWith('registry:') && t !== 'registry:*').map(t => t.slice(9)) : [];
  const toggle = (arr: string[], v: string, on: boolean) => (on ? [...arr, v] : arr.filter(x => x !== v));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!checked.ok || readOnly) return;
    setBusy(true);
    setServerError('');
    try {
      await onSubmit(text, nodeId);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function importFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) setText(await f.text());
    e.target.value = '';
  }

  function exportFile() {
    const name = af?.name ?? 'agentfile';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/yaml' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${name}.yaml` });
    a.click();
    URL.revokeObjectURL(url);
  }

  const id = (s: string) => `${uid}-${s}`;

  return (
    <form className="editor" onSubmit={submit}>
      <div className="editor-bar">
        <div className="seg" role="tablist" aria-label="Editor mode">
          {(['form', 'yaml'] as const).map(t => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === 'form' ? 'Form' : 'YAML'}
            </button>
          ))}
        </div>
        {mode === 'create' && (
          <label className="inline-field">
            <span>Template</span>
            <select
              name="template"
              defaultValue="blank"
              onChange={e => setText(TEMPLATES.find(t => t.id === e.target.value)?.text ?? text)}
            >
              {TEMPLATES.map(t => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="editor-files">
          <button type="button" onClick={() => fileInput.current?.click()} disabled={readOnly}>
            Import .yaml
          </button>
          <input ref={fileInput} type="file" accept=".yaml,.yml,text/yaml" hidden onChange={importFile} />
          <button type="button" onClick={exportFile}>
            Export .yaml
          </button>
        </span>
      </div>

      {tab === 'yaml' || !af ? (
        <>
          {tab === 'form' && <p className="editor-note">The YAML has errors, so the form is off until they're fixed.</p>}
          <label className="sr-only" htmlFor={id('yaml')}>
            Agentfile YAML
          </label>
          <textarea
            id={id('yaml')}
            name="agentfile"
            className="editor-yaml"
            spellCheck={false}
            value={text}
            readOnly={readOnly}
            onChange={e => setText(e.target.value)}
            rows={16}
          />
        </>
      ) : (
        <fieldset className="editor-form" disabled={readOnly}>
          <label htmlFor={id('name')}>Name</label>
          <input id={id('name')} name="name" autoComplete="off" spellCheck={false} value={af.name} onChange={e => update({ name: e.target.value })} />
          <label htmlFor={id('purpose')}>Purpose (its system prompt)</label>
          <textarea id={id('purpose')} name="purpose" rows={5} value={af.purpose} onChange={e => update({ purpose: e.target.value })} />
          <label htmlFor={id('channels')}>Channels</label>
          <input
            id={id('channels')}
            name="channels"
            autoComplete="off"
            spellCheck={false}
            value={af.channels.join(', ')}
            onChange={e => update({ channels: list(e.target.value) })}
            placeholder="general, capacity…"
          />
          <fieldset className="checks">
            <legend>Wakes on</legend>
            {TRIGGERS.map(t => (
              <label key={t}>
                <input type="checkbox" checked={af.triggers.includes(t)} onChange={e => update({ triggers: toggle(af.triggers, t, e.target.checked) })} />
                {t.replace('_', ' ')}
              </label>
            ))}
          </fieldset>
          <fieldset className="checks">
            <legend>Tools</legend>
            {BUILTIN_TOOLS.map(t => (
              <label key={t}>
                <input type="checkbox" checked={af.tools.includes(t)} onChange={e => update({ tools: toggle(af.tools, t, e.target.checked) })} />
                <code>{t === 'registry:*' ? 'all approved tools' : `/${t}`}</code>
              </label>
            ))}
          </fieldset>
          <label htmlFor={id('registry')}>Specific approved tools</label>
          <input
            id={id('registry')}
            name="registry"
            autoComplete="off"
            spellCheck={false}
            value={registry.join(', ')}
            onChange={e =>
              update({ tools: [...af.tools.filter(t => !t.startsWith('registry:') || t === 'registry:*'), ...list(e.target.value).map(n => `registry:${n}`)] })
            }
            placeholder="host_power, pdu_reading…"
          />
          <div className="budget">
            <span>
              <label htmlFor={id('turns')}>Turn budget</label>
              <input id={id('turns')} name="turns" type="number" inputMode="numeric" min={1} max={50} value={af.budget.turns} onChange={e => update({ budget: { ...af.budget, turns: Number(e.target.value) } })} />
            </span>
            <span>
              <label htmlFor={id('minutes')}>Minutes</label>
              <input id={id('minutes')} name="minutes" type="number" inputMode="numeric" min={1} max={60} value={af.budget.minutes} onChange={e => update({ budget: { ...af.budget, minutes: Number(e.target.value) } })} />
            </span>
          </div>
          <p className="editor-note">
            Adapters: {af.adapters.length ? af.adapters.map(a => `${a.name}@${a.version} × ${a.weight}`).join(', ') : 'base model only'}. Set them in Adapters.
          </p>
        </fieldset>
      )}

      {!checked.ok && (
        <ul className="editor-errors" role="alert">
          {checked.errors.map(e => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {serverError && (
        <p className="form-error" role="alert">
          {serverError}
        </p>
      )}
      {readOnlyReason && <p className="editor-note">{readOnlyReason}</p>}

      <div className="editor-actions">
        {mode === 'create' && (
          <label className="inline-field">
            <span>Runs on</span>
            <select name="node" value={nodeId === undefined ? '' : String(nodeId)} onChange={e => setNodeId(BigInt(e.target.value))} disabled={!nodes.length}>
              {!nodes.length && <option value="">No nodes registered</option>}
              {nodes.map(n => (
                <option key={String(n.id)} value={String(n.id)}>
                  {n.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn-primary" disabled={busy || readOnly || !checked.ok || (mode === 'create' && nodeId === undefined)}>
          {busy ? 'Saving…' : mode === 'create' ? 'Create agent' : 'Save Agentfile'}
        </button>
      </div>
    </form>
  );
}
