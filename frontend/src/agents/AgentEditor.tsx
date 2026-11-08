import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { RemiAvatar } from '../components/RemiAvatar';
import { defaultLook } from '../components/remiLook';
import { usableSkills } from './skills';
import { mcpTile } from '../config/mcpApps';
import { setUnsaved } from '../unsaved';
import { LOADOUT } from './loadout';
import { BUILTIN_TOOLS, TEMPLATES, TRIGGERS, checkAgentfile, toYaml, type Agentfile } from './agentfile';

type Props = {
  mode: 'create' | 'edit';
  initialText: string;
  nodes?: readonly { id: bigint; name: string; gpu: string; baseModel: string; status: string }[];
  homeId?: bigint; // edit mode: the node it lives on now (moving it is the Move form above the editor)
  channels?: readonly string[]; // the workspace's public channels, offered as chips
  adapters?: Parameters<typeof usableSkills>[0];
  adapterCopies?: Parameters<typeof usableSkills>[1];
  mcpServers?: readonly { name: string; host: string }[]; // connected apps (Settings → Apps), shown as backpack tiles
  readOnlyReason?: string;
  onSubmit: (text: string, nodeId?: bigint) => Promise<void>;
  onCancel?: () => void;
};

const WAKES: Record<(typeof TRIGGERS)[number], string> = {
  mention: 'someone @mentions it',
  dm: 'someone messages it directly',
  every_message: 'anyone posts in its channels',
  sleep_event: 'the nightly sleep runs',
};

// What a drag carries: a tool id or a LoRA key (name@version).
type Dragged = { kind: 'tool' | 'skill'; id: string };
const DRAG_TYPE = 'application/x-remi-item';
const drag = (d: Dragged) => (e: DragEvent) => {
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(d));
  e.dataTransfer.effectAllowed = 'move';
};

// A drop zone for tools or skills: "equipped" (backpack, learned) or "available".
function Shelf({ label, equipped, empty, disabled, onDropItem, children }: { label: string; equipped: boolean; empty: string; disabled: boolean; onDropItem: (d: Dragged) => void; children: ReactNode[] }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className="shelf"
      data-equipped={equipped}
      data-over={over}
      onDragOver={e => {
        if (disabled || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        setOver(false);
        if (disabled) return;
        e.preventDefault();
        try {
          onDropItem(JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as Dragged);
        } catch {
          // not one of ours
        }
      }}
    >
      <span className="shelf-label">{label}</span>
      <div className="shelf-items">{children.length ? children : <p className="shelf-empty">{empty}</p>}</div>
    </div>
  );
}

const list = (s: string) =>
  s
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

// Form and YAML edit the same Agentfile text; the schema check runs on every keystroke.
export function AgentEditor({ mode, initialText, nodes = [], homeId, channels = [], adapters = [], adapterCopies = [], mcpServers = [], readOnlyReason, onSubmit, onCancel }: Props) {
  const uid = useId();
  const [text, setText] = useState(initialText);
  // `base` is what the text was loaded from; edits are unsaved while text differs from it.
  const [base, setBase] = useState(initialText);
  const [seen, setSeen] = useState(initialText);
  const [stale, setStale] = useState(false);
  const dirty = text !== base;
  // The row changed underneath us: follow it if nothing is unsaved, otherwise keep the edits and say so.
  if (initialText !== seen) {
    setSeen(initialText);
    if (!dirty || initialText === text) {
      setText(initialText);
      setBase(initialText);
      setStale(false);
    } else setStale(true);
  }
  const [tab, setTab] = useState<'form' | 'yaml'>('form');
  const [nodeId, setNodeId] = useState<bigint | undefined>(nodes[0]?.id);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const problemsRef = useRef<HTMLUListElement>(null);
  const [tried, setTried] = useState(false);
  const [showProblems, setShowProblems] = useState(0); // bumped on each blocked save, to move focus after render
  useEffect(() => {
    if (showProblems) problemsRef.current?.focus();
  }, [showProblems]);
  const checked = useMemo(() => checkAgentfile(text), [text]);
  const af = checked.ok ? checked.value : undefined;
  const readOnly = !!readOnlyReason;

  const label = mode === 'create' ? 'the new agent' : (af?.name ?? 'this agent');
  useEffect(() => {
    setUnsaved(dirty && !readOnly ? `Discard unsaved changes to ${label}?` : null);
    return () => setUnsaved(null);
  }, [dirty, readOnly, label]);

  const update = (patch: Partial<Agentfile>) => af && setText(toYaml({ ...af, ...patch }));
  // Typed text lives in `draft` until the file it would make is valid, so clearing a field to retype it (or typing the
  // comma in "general, ops") never throws you out of the form. Blur drops the draft and shows the saved value.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [draftErrors, setDraftErrors] = useState<string[]>([]);
  const edit = (key: string, raw: string, patch: Partial<Agentfile>) => {
    if (!af) return;
    setDraft(d => ({ ...d, [key]: raw }));
    const next = toYaml({ ...af, ...patch });
    const c = checkAgentfile(next);
    if (c.ok) {
      setText(next);
      setDraftErrors([]);
    } else setDraftErrors(c.errors);
  };
  const shown = (key: string, v: string | number) => draft[key] ?? String(v);
  const settle = (key: string) => {
    setDraft(d => Object.fromEntries(Object.entries(d).filter(([k]) => k !== key)));
    setDraftErrors([]);
  };
  const registry = af ? af.tools.filter(t => t.startsWith('registry:') && t !== 'registry:*').map(t => t.slice(9)) : [];
  const mcp = af ? af.tools.filter(t => t.startsWith('mcp:')).map(t => t.slice(4)) : [];
  const toggle = (arr: string[], v: string, on: boolean) => (on ? [...arr, v] : arr.filter(x => x !== v));
  // built-ins plus one tile per connected app; each tile is one entry in the Agentfile's tools
  const tiles = [...BUILTIN_TOOLS.map(t => ({ id: t as string, ...LOADOUT[t] })), ...mcpServers.map(mcpTile)];
  const home = nodes.find(n => n.id === (mode === 'create' ? nodeId : homeId));
  const skills = usableSkills(adapters, adapterCopies, home);
  // one version of a skill at a time: learning v2 replaces v1
  const learn = (key: string) => {
    const s = skills.find(k => `${k.name}@${k.version}` === key);
    if (af && s) update({ adapters: [...af.adapters.filter(a => a.name !== s.name), { name: s.name, version: s.version, weight: 1 }] });
  };
  const forget = (key: string) => af && update({ adapters: af.adapters.filter(a => `${a.name}@${a.version}` !== key) });

  const needsNode = mode === 'create' && nodeId === undefined;
  const problems = [
    ...(checked.ok ? draftErrors : checked.errors),
    ...(needsNode && tried ? ['Pick a node to run it on. No nodes yet? Run remi up on a GPU machine.'] : []),
  ];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (readOnly) return;
    if (!checked.ok || needsNode) {
      // Save stays enabled; pressing it with problems takes you to them.
      setTried(true);
      setShowProblems(n => n + 1);
      return;
    }
    setBusy(true);
    setServerError('');
    try {
      await onSubmit(text, nodeId);
      setBase(text);
      setStale(false);
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
      {stale && (
        <p className="editor-stale" role="status">
          This agent changed elsewhere while you were editing. Saving overwrites that change.{' '}
          <button
            type="button"
            onClick={() => {
              setText(initialText);
              setBase(initialText);
              setStale(false);
            }}
          >
            Load latest
          </button>
        </p>
      )}
      <div className="editor-bar">
        <div className="seg" role="tablist" aria-label="Editor mode">
          {(['form', 'yaml'] as const).map(t => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === 'form' ? 'Simple' : 'YAML'}
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
          <section className="ed-section ed-who" aria-labelledby={id('who')}>
            <RemiAvatar status="idle" {...defaultLook({ name: af.name, protected: false })} size={88} className="ed-avatar" />
            <div className="ed-who-fields">
              <h3 id={id('who')}>Who is it?</h3>
              <label htmlFor={id('name')}>Name</label>
              <input id={id('name')} name="name" autoComplete="off" spellCheck={false} value={shown('name', af.name)} onChange={e => edit('name', e.target.value, { name: e.target.value })} onBlur={() => settle('name')} />
              <label htmlFor={id('purpose')}>What's its job?</label>
              <textarea
                id={id('purpose')}
                name="purpose"
                rows={4}
                value={shown('purpose', af.purpose)}
                placeholder="e.g. Keep an eye on the lab's GPUs and tell #ops when one runs hot…"
                onChange={e => edit('purpose', e.target.value, { purpose: e.target.value })}
                onBlur={() => settle('purpose')}
              />
            </div>
          </section>

          {mode === 'create' && (
            <section className="ed-section" aria-labelledby={id('home')}>
              <h3 id={id('home')}>Where does it live?</h3>
              <p className="ed-hint">Pick the machine it runs on. It uses that machine's GPU and model.</p>
              {nodes.length === 0 ? (
                <p className="ed-empty">No machines yet. Run <code>remi up</code> on a computer with a GPU and it shows up here.</p>
              ) : (
                <div className="ed-homes" role="radiogroup" aria-labelledby={id('home')}>
                  {nodes.map(n => (
                    <label key={String(n.id)} className="ed-home" data-on={n.id === nodeId}>
                      <input type="radio" name="home" checked={n.id === nodeId} onChange={() => {
                          setNodeId(n.id);
                          // skills only work on the machine's own model, so drop any the new home can't use
                          const ok = usableSkills(adapters, adapterCopies, n);
                          if (af.adapters.some(a => !ok.some(k => k.name === a.name && k.version === a.version)))
                            update({ adapters: af.adapters.filter(a => ok.some(k => k.name === a.name && k.version === a.version)) });
                        }}
                      />
                      <b>{n.name}</b>
                      <small>{n.gpu || 'GPU unknown'}</small>
                      <small>{n.baseModel}</small>
                      <span className={`ed-home-status status-${n.status}`}>{n.status === 'up' ? 'online' : n.status}</span>
                    </label>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="ed-section" aria-labelledby={id('where')}>
            <h3 id={id('where')}>Where does it hang out?</h3>
            <div className="ed-chips" role="group" aria-labelledby={id('where')}>
              {[...new Set([...channels, ...af.channels])].map(c => (
                <label key={c} className="ed-chip" data-on={af.channels.includes(c)}>
                  <input type="checkbox" checked={af.channels.includes(c)} onChange={e => update({ channels: toggle(af.channels, c, e.target.checked) })} /># {c}
                </label>
              ))}
            </div>
            <h4 id={id('wakes')}>Wakes up when…</h4>
            <div className="ed-chips" role="group" aria-labelledby={id('wakes')}>
              {TRIGGERS.map(t => (
                <label key={t} className="ed-chip" data-on={af.triggers.includes(t)}>
                  <input type="checkbox" checked={af.triggers.includes(t)} onChange={e => update({ triggers: toggle(af.triggers, t, e.target.checked) })} />
                  {WAKES[t]}
                </label>
              ))}
            </div>
          </section>

          <section className="ed-section" aria-labelledby={id('can')}>
            <h3 id={id('can')}>What can it do?</h3>
            <p className="ed-hint">Drag tools into its backpack, or click one to add or remove it.</p>
            {mcpServers.length === 0 && <p className="ed-hint">Want Gmail, GitHub, Slack and more? An admin can connect Composio in Settings → Apps.</p>}
            <div className="ed-shelves">
              {([true, false] as const).map(equipped => (
                <Shelf
                  key={String(equipped)}
                  label={equipped ? `Backpack · ${tiles.filter(t => af.tools.includes(t.id)).length}` : 'Available'}
                  equipped={equipped}
                  empty={equipped ? 'Empty. It can only chat.' : 'Everything is packed.'}
                  disabled={readOnly}
                  onDropItem={d => d.kind === 'tool' && af.tools.includes(d.id) !== equipped && update({ tools: toggle(af.tools, d.id, equipped) })}
                >
                  {tiles
                    .filter(t => af.tools.includes(t.id) === equipped)
                    .map(t => (
                      <label key={t.id} className="loadout-tile" data-on={equipped} draggable={!readOnly} onDragStart={drag({ kind: 'tool', id: t.id })}>
                        <input type="checkbox" checked={equipped} onChange={e => update({ tools: toggle(af.tools, t.id, e.target.checked) })} />
                        <span className="loadout-icon" aria-hidden="true">
                          {t.icon}
                        </span>
                        <b>{t.title}</b>
                        <small>{t.does}</small>
                      </label>
                    ))}
                </Shelf>
              ))}
            </div>
          </section>

          <section className="ed-section" aria-labelledby={id('learned')}>
            <h3 id={id('learned')}>What has it learned?</h3>
            <p className="ed-hint">Skills are LoRAs that Sleep REMi trained overnight. Drag one on to teach it, and set how strongly it applies.</p>
            {af.adapters.length === 0 && skills.length === 0 ? (
              <p className="ed-empty">
                {home ? `No skills trained for ${home.name}'s model yet. Sleep REMi adds them after a night's training.` : 'Pick where it lives first.'}
              </p>
            ) : (
              <div className="ed-shelves">
                <Shelf
                  label={`Learned · ${af.adapters.length}`}
                  equipped
                  empty="None yet. It uses the plain model."
                  disabled={readOnly}
                  onDropItem={d => d.kind === 'skill' && learn(d.id)}
                >
                  {af.adapters.map(a => (
                    <div key={`${a.name}@${a.version}`} className="skill-tile" data-on="true">
                      <span className="loadout-icon" aria-hidden="true">
                        ✨
                      </span>
                      <b>
                        {a.name} <small>v{a.version}</small>
                      </b>
                      <label className="skill-strength">
                        <span>Strength</span>
                        <input
                          type="range"
                          min={0.1}
                          max={2}
                          step={0.1}
                          value={a.weight}
                          onChange={e => update({ adapters: af.adapters.map(x => (x === a ? { ...x, weight: Number(e.target.value) } : x)) })}
                        />
                        <output>{a.weight.toFixed(1)}×</output>
                      </label>
                      <button type="button" className="skill-remove" onClick={() => update({ adapters: af.adapters.filter(x => x !== a) })} aria-label={`Forget ${a.name}`}>
                        Forget
                      </button>
                    </div>
                  ))}
                </Shelf>
                <Shelf label="Available" equipped={false} empty="Nothing else trained for this model." disabled={readOnly} onDropItem={d => d.kind === 'skill' && forget(d.id)}>
                  {skills
                    .filter(s => !af.adapters.some(a => a.name === s.name))
                    .map(s => (
                      <button
                        key={`${s.name}@${s.version}`}
                        type="button"
                        className="skill-tile"
                        draggable={!readOnly}
                        onDragStart={drag({ kind: 'skill', id: `${s.name}@${s.version}` })}
                        onClick={() => learn(`${s.name}@${s.version}`)}
                      >
                        <span className="loadout-icon" aria-hidden="true">
                          ✨
                        </span>
                        <b>
                          {s.name} <small>v{s.version}</small>
                        </b>
                        <small>{s.description || 'No description'}</small>
                      </button>
                    ))}
                </Shelf>
              </div>
            )}
          </section>

          <section className="ed-section" aria-labelledby={id('energy')}>
            <h3 id={id('energy')}>How hard does it work?</h3>
            <p className="ed-hint">Each time it wakes up, it stops after this many steps or minutes.</p>
            <div className="energy">
              <label htmlFor={id('turns')}>Steps</label>
              <input id={id('turns')} name="turns" type="range" min={1} max={50} value={af.budget.turns} onChange={e => update({ budget: { ...af.budget, turns: Number(e.target.value) } })} />
              <output htmlFor={id('turns')}>{af.budget.turns}</output>
              <label htmlFor={id('minutes')}>Minutes</label>
              <input id={id('minutes')} name="minutes" type="range" min={1} max={60} value={af.budget.minutes} onChange={e => update({ budget: { ...af.budget, minutes: Number(e.target.value) } })} />
              <output htmlFor={id('minutes')}>{af.budget.minutes}</output>
            </div>
          </section>

          <details className="ed-section ed-advanced">
            <summary>Advanced</summary>
            <label htmlFor={id('registry')}>Specific approved tools</label>
            <input
              id={id('registry')}
              name="registry"
              autoComplete="off"
              spellCheck={false}
              value={shown('registry', registry.join(', '))}
              onChange={e =>
                edit('registry', e.target.value, {
                  tools: [...af.tools.filter(t => !t.startsWith('registry:') || t === 'registry:*'), ...list(e.target.value).map(n => `registry:${n}`)],
                })
              }
              onBlur={() => settle('registry')}
              placeholder="host_power, pdu_reading…"
            />
            <label htmlFor={id('mcp')}>MCP tools</label>
            <input
              id={id('mcp')}
              name="mcp"
              autoComplete="off"
              spellCheck={false}
              value={shown('mcp', mcp.join(', '))}
              onChange={e => edit('mcp', e.target.value, { tools: [...af.tools.filter(t => !t.startsWith('mcp:')), ...list(e.target.value).map(n => `mcp:${n}`)] })}
              onBlur={() => settle('mcp')}
              placeholder="composio/*, composio/GMAIL_SEND_EMAIL…"
            />
            <p className="ed-hint">The whole setup is also editable as YAML: switch to YAML at the top.</p>
          </details>
        </fieldset>
      )}

      {problems.length > 0 && (
        <ul className="editor-errors" ref={problemsRef} tabIndex={-1} aria-label="Problems to fix before saving">
          {problems.map(e => (
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
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn-primary" disabled={busy || readOnly}>
          {busy ? 'Saving…' : mode === 'create' ? `Create ${af?.name || 'agent'}` : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
