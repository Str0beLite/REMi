import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import type { Identity } from 'spacetimedb';
import { reducers, tables } from '../module_bindings';
import type { Agent } from '../module_bindings/types';
import { useUpload } from './useUpload';
import { sizeLabel, type Listing, type Opened } from './fsResult';
import './files.css';

type Props = { agent: Agent; nodeName: string; me: Identity | undefined; canBrowse: boolean };

const ROOTS = ['/workspace', '/shared'];
const SLOW_MS = 15_000;

// An agent's sandbox from the console (#98): anyone may upload into /shared; its owner or an admin may look around.
export function FilesView({ agent, nodeName, me, canBrowse }: Props) {
  const ask = useReducer(reducers.fsAsk);
  const query = useMemo(() => tables.fsRequest.where(r => r.agentId.eq(agent.id)), [agent.id]);
  const [rows] = useTable(query);
  const [members] = useTable(tables.member);
  const [channels] = useTable(tables.channel);
  const { upload, status } = useUpload();
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // the request on screen: answers are rows newer than `after` that match it
  const [want, setWant] = useState<{ op: 'list' | 'read'; path: string; after: bigint }>();
  const [cwd, setCwd] = useState('/workspace');
  const [askError, setAskError] = useState('');
  const [slow, setSlow] = useState(false);

  // The delivery line goes to a channel the agent is in, so the mention wakes it; #general otherwise.
  const theirs = new Set(members.filter(m => m.memberKind === 'agent' && m.memberId === String(agent.id)).map(m => m.channelId));
  const channel = channels.find(c => c.kind === 'public' && theirs.has(c.id)) ?? channels.find(c => c.kind === 'public' && c.name === 'general');

  async function go(op: 'list' | 'read', path: string) {
    setAskError('');
    const after = rows.reduce((m, r) => (r.id > m ? r.id : m), 0n);
    try {
      await ask({ agentId: agent.id, op, path });
      setWant({ op, path, after });
      if (op === 'list') setCwd(path);
    } catch (err) {
      setAskError(err instanceof Error ? err.message : String(err));
    }
  }

  const answer = want
    ? rows
        .filter(r => r.id > want.after && r.op === want.op && r.path === want.path && !!me && r.requestedBy.isEqual(me))
        .reduce<(typeof rows)[number] | undefined>((best, r) => (!best || r.id > best.id ? r : best), undefined)
    : undefined;
  const pending = !!want && (!answer || answer.state === 'pending');

  useEffect(() => {
    setSlow(false);
    if (!pending) return;
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [pending, want]);

  // first look: the workspace listing
  useEffect(() => {
    if (canBrowse) void go('list', '/workspace');
    // once per agent; go() reads fresh rows when it runs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, canBrowse]);

  function send(files: FileList | null) {
    const file = files?.[0];
    if (!file || !channel) return;
    void upload(file, agent.id, agent.name, channel.id).then(ok => {
      if (ok && canBrowse && cwd === '/shared') void go('list', '/shared');
    });
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    send(e.dataTransfer.files);
  };

  let listing: Listing | undefined;
  let opened: Opened | undefined;
  if (answer?.state === 'done') {
    try {
      const parsed = JSON.parse(answer.result);
      if (answer.op === 'list') listing = parsed;
      else opened = parsed;
    } catch {
      // a malformed answer shows as nothing; the node logs its own errors
    }
  }
  const parent = cwd.split('/').slice(0, -1).join('/');

  return (
    <section
      className={`files${dragging ? ' files-drag' : ''}`}
      aria-labelledby="files-title"
      onDragOver={e => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={e => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={onDrop}
    >
      <div className="files-head">
        <h3 id="files-title">Files</h3>
        <input ref={picker} type="file" hidden onChange={e => {
            send(e.target.files);
            e.target.value = ''; // picking the same file again still uploads
          }}
        />
        <button type="button" onClick={() => picker.current?.click()} disabled={status.busy || !channel}>
          Upload to /shared…
        </button>
      </div>
      <p className="files-hint">
        Drop a file here or pick one: it lands in {agent.name}'s <code>/shared</code> on {nodeName}, up to 50 MB.
      </p>
      <p className={status.error ? 'form-error' : 'files-status'} role="status" aria-live="polite">
        {status.text}
      </p>

      {!canBrowse ? (
        <p className="files-hint">Only {agent.name}'s owner or an admin can look inside its sandbox.</p>
      ) : (
        <>
          <nav className="files-path" aria-label="Folder">
            {ROOTS.map(r => (
              <button key={r} type="button" aria-current={cwd === r || cwd.startsWith(`${r}/`) ? 'true' : undefined} onClick={() => go('list', r)}>
                {r}
              </button>
            ))}
            {!ROOTS.includes(cwd) && (
              <>
                <button type="button" onClick={() => go('list', parent)}>
                  <span aria-hidden="true">↑</span> Up a folder
                </button>
                <code className="files-cwd">{cwd}</code>
              </>
            )}
          </nav>
          {askError && (
            <p className="form-error" role="alert">
              {askError}
            </p>
          )}
          {pending && (
            <p className="files-status" role="status">
              {slow ? `No answer from ${nodeName} yet. Is it up?` : `Asking ${nodeName}…`}
            </p>
          )}
          {answer?.state === 'failed' && (
            <p className="form-error" role="alert">
              {answer.result}
            </p>
          )}
          {opened && want ? (
            <OpenedFile file={opened} onBack={() => go('list', cwd)} />
          ) : (
            listing && (
              <>
                {listing.entries.length === 0 ? (
                  <p className="files-hint">Empty.</p>
                ) : (
                  <table className="files-table">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Size</th>
                        <th scope="col">Modified</th>
                      </tr>
                    </thead>
                    <tbody>
                      {listing.entries.map(e => (
                        <tr key={e.name}>
                          <td>
                            <button type="button" className="files-entry" onClick={() => go(e.type === 'dir' ? 'list' : 'read', `${cwd}/${e.name}`)}>
                              {e.name}
                              {e.type === 'dir' ? '/' : e.type === 'link' ? ' (link)' : ''}
                            </button>
                          </td>
                          <td className="files-num">{e.type === 'dir' ? '' : sizeLabel(e.size)}</td>
                          <td className="files-num">{new Date(e.mtime * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {listing.truncated && <p className="files-hint">Showing the first 500 entries.</p>}
              </>
            )
          )}
        </>
      )}
    </section>
  );
}

function OpenedFile({ file, onBack }: { file: Opened; onBack: () => void }) {
  const name = file.path.split('/').at(-1) ?? 'file';
  function download() {
    const body = file.encoding === 'utf8' ? file.data : Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([body]));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="files-open">
      <div className="files-head">
        <button type="button" onClick={onBack}>
          <span aria-hidden="true">←</span> Back
        </button>
        <code className="files-cwd">{file.path}</code>
        <span className="files-num">{sizeLabel(file.size)}</span>
        <button type="button" onClick={download} disabled={file.truncated}>
          Download
        </button>
      </div>
      {file.truncated && (
        <p className="files-hint">
          Over 1 MB: showing the first 1 MB, so it can't be downloaded here. Ask the REMi to <code>/send</code> it, or split it.
        </p>
      )}
      {file.encoding === 'utf8' ? <pre className="files-text">{file.data}</pre> : <p className="files-hint">Binary file: download it to open it.</p>}
    </div>
  );
}
