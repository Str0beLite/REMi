import { useState, type FormEvent } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';

import { COMPOSIO } from './mcpApps';

const NAME = /^[a-z0-9-]{2,32}$/;

// Admins: the remote MCP servers REMis may call (CONTRACT §4, #73). Composio gets a one-key card (#90); anything else uses
// the generic form. URLs and keys are write-only: they go to a private table only the nodes read.
export function McpServers() {
  const { identity } = useSpacetimeDB();
  const [users] = useTable(tables.user);
  const [servers] = useTable(tables.mcpServer);
  const setServer = useReducer(reducers.setMcpServer);
  const removeServer = useReducer(reducers.removeMcpServer);
  const [composioKey, setComposioKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [header, setHeader] = useState('x-api-key');
  const [key, setKey] = useState('');
  const [state, setState] = useState('');
  const [error, setError] = useState('');
  const isAdmin = users.find(u => identity && u.identity.isEqual(identity))?.isAdmin === true;
  if (!isAdmin) return null;

  const composio = servers.find(s => s.name === COMPOSIO.name);
  const others = [...servers].filter(s => s.name !== COMPOSIO.name).sort((a, b) => a.name.localeCompare(b.name));
  const nameError = name && !NAME.test(name) ? 'Use 2–32 characters: a–z, 0–9 and -.' : '';
  const urlError = url && !/^https:\/\/[^/?#\s]+/.test(url) ? 'Use an https:// address.' : '';

  async function put(n: string, u: string, headers: Record<string, string>, done: () => void) {
    setState('Saving…');
    setError('');
    try {
      await setServer({ name: n, url: u, headers: JSON.stringify(headers) });
      setState(`Saved ${n}`);
      done();
    } catch (err) {
      setState('');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function connectComposio(e: FormEvent) {
    e.preventDefault();
    const k = composioKey.trim();
    if (!k) return;
    void put(COMPOSIO.name, COMPOSIO.url, { [COMPOSIO.header]: k }, () => {
      setComposioKey('');
      setReplacing(false);
    });
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (nameError || urlError) return;
    void put(name, url.trim(), key ? { [header.trim() || 'x-api-key']: key } : {}, () => {
      setName('');
      setUrl('');
      setKey('');
    });
  }

  async function remove(n: string) {
    if (!window.confirm(`Disconnect ${n}? REMis that use it lose those apps.`)) return;
    setError('');
    try {
      await removeServer({ name: n });
      setState(`Removed ${n}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <h2>Apps</h2>
      <p className="setting-hint">Outside apps your REMis can use. Once an app is connected, drag it into a REMi's backpack in Agents.</p>

      <div className="composio-card" data-on={!!composio}>
        <div className="composio-head">
          <span className="composio-logo" aria-hidden="true">
            🧩
          </span>
          <div>
            <b>Composio</b>
            <small>Gmail, GitHub, Slack, Google Calendar, Notion and 500+ more apps</small>
          </div>
          {composio && <span className="composio-status">Connected</span>}
        </div>
        {composio && !replacing ? (
          <div className="setting-row">
            <small className="setting-hint">Added by {composio.addedBy}. The key is stored for the machines only and never shown again.</small>
            <button type="button" onClick={() => setReplacing(true)}>
              Replace key
            </button>
            <button type="button" className="mcp-remove" onClick={() => remove(COMPOSIO.name)}>
              Disconnect
            </button>
          </div>
        ) : (
          <form className="setting" onSubmit={connectComposio}>
            <label htmlFor="composio-key">Composio API key</label>
            <p className="setting-hint">
              Copy it from your{' '}
              <a href="https://composio.dev" target="_blank" rel="noreferrer">
                Composio dashboard
              </a>
              . That's all: the address and settings are filled in for you.
            </p>
            <div className="setting-row">
              <input
                id="composio-key"
                name="composio-key"
                type="password"
                className="mono"
                autoComplete="off"
                spellCheck={false}
                value={composioKey}
                placeholder="Paste your key…"
                onChange={e => setComposioKey(e.target.value)}
              />
              <button type="submit" className="btn-primary" disabled={!composioKey.trim() || state === 'Saving…'}>
                {composio ? 'Save new key' : 'Connect'}
              </button>
              {replacing && (
                <button type="button" onClick={() => setReplacing(false)}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}
      </div>

      {others.length > 0 && (
        <ul className="people">
          {others.map(s => (
            <li key={s.name}>
              <span className="people-name mono">{s.name}</span>
              <span className="people-you">
                {s.host} · added by {s.addedBy}
              </span>
              <button type="button" className="mcp-remove" onClick={() => remove(s.name)} aria-label={`Remove ${s.name}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <span className="setting-state" role="status">
        {state}
      </span>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <details className="mcp-other">
        <summary>Other MCP server</summary>
        <form className="setting mcp-form" onSubmit={save}>
          <p className="setting-hint">Any remote MCP server. Saving a name that exists replaces its URL and key. The key is never shown again.</p>
          <label htmlFor="mcp-name">Name</label>
          <input id="mcp-name" name="mcp-name" className="mono" autoComplete="off" spellCheck={false} required value={name}
            placeholder="my-server…" aria-invalid={!!nameError} onChange={e => setName(e.target.value)} />
          {nameError && <p className="form-error">{nameError}</p>}
          <label htmlFor="mcp-url">URL</label>
          <input id="mcp-url" name="mcp-url" type="url" className="mono" autoComplete="off" spellCheck={false} required value={url}
            placeholder="https://…" aria-invalid={!!urlError} onChange={e => setUrl(e.target.value)} />
          {urlError && <p className="form-error">{urlError}</p>}
          <label htmlFor="mcp-header">Key header</label>
          <input id="mcp-header" name="mcp-header" className="mono" autoComplete="off" spellCheck={false} value={header}
            onChange={e => setHeader(e.target.value)} />
          <label htmlFor="mcp-key">API key</label>
          <div className="setting-row">
            <input id="mcp-key" name="mcp-key" type="password" className="mono" autoComplete="off" spellCheck={false} value={key}
              placeholder="Leave empty if the server needs none" onChange={e => setKey(e.target.value)} />
            <button type="submit" disabled={!name || !url || !!nameError || !!urlError || state === 'Saving…'}>
              Save
            </button>
          </div>
        </form>
      </details>
    </section>
  );
}
