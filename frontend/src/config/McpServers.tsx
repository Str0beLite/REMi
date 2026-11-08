import { useState, type FormEvent } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';

const NAME = /^[a-z0-9-]{2,32}$/;

// Admins: the remote MCP servers REMis may call (CONTRACT §4, #73). The URL and key are write-only: they go to a private
// table only the nodes read, so this list shows just name, host and who added it.
export function McpServers() {
  const { identity } = useSpacetimeDB();
  const [users] = useTable(tables.user);
  const [servers] = useTable(tables.mcpServer);
  const setServer = useReducer(reducers.setMcpServer);
  const removeServer = useReducer(reducers.removeMcpServer);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [header, setHeader] = useState('x-api-key');
  const [key, setKey] = useState('');
  const [state, setState] = useState('');
  const [error, setError] = useState('');
  const isAdmin = users.find(u => identity && u.identity.isEqual(identity))?.isAdmin === true;
  if (!isAdmin) return null;

  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name));
  const nameError = name && !NAME.test(name) ? 'Use 2–32 characters: a–z, 0–9 and -.' : '';
  const urlError = url && !/^https:\/\/[^/?#\s]+/.test(url) ? 'Use an https:// address.' : '';

  async function save(e: FormEvent) {
    e.preventDefault();
    if (nameError || urlError) return;
    setState('Saving…');
    setError('');
    try {
      await setServer({ name, url: url.trim(), headers: JSON.stringify(key ? { [header.trim() || 'x-api-key']: key } : {}) });
      setState(`Saved ${name}`);
      setName('');
      setUrl('');
      setKey('');
    } catch (err) {
      setState('');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(n: string) {
    if (!window.confirm(`Remove the MCP server ${n}? REMis that use it lose those tools.`)) return;
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
      <h2>MCP servers</h2>
      <p className="setting-hint">
        Outside apps REMis can use, such as Composio. Give a REMi a server's tools with <code>mcp:&lt;server&gt;/*</code> in its
        Agentfile.
      </p>
      {sorted.length > 0 && (
        <ul className="people">
          {sorted.map(s => (
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
      <form className="setting mcp-form" onSubmit={save}>
        <span className="admin-link-label">Add or replace a server</span>
        <p className="setting-hint">Saving a name that exists replaces its URL and key. The key is never shown again.</p>
        <label htmlFor="mcp-name">Name</label>
        <input id="mcp-name" name="mcp-name" className="mono" autoComplete="off" spellCheck={false} required value={name}
          placeholder="composio…" aria-invalid={!!nameError} onChange={e => setName(e.target.value)} />
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
          <span className="setting-state" role="status">
            {state}
          </span>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
