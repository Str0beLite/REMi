import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../module_bindings';
import type { Agent, Channel, Message, User } from '../module_bindings/types';
import { MessageItem } from './MessageItem';
import { authorOf } from './model';

type Props = {
  channel: Channel;
  title: string;
  parent?: Channel;
  threads: readonly Channel[];
  messages: readonly Message[];
  users: readonly User[];
  agents: readonly Agent[];
  me: string;
  connected: boolean;
  onOpen: (id: bigint) => void;
};

const GROUP_MS = 5 * 60 * 1000;

export function ChatView({ channel, title, parent, threads, messages, users, agents, me, connected, onOpen }: Props) {
  const post = useReducer(reducers.postMessage);
  const createChannel = useReducer(reducers.createChannel);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [threadName, setThreadName] = useState<string | null>(null);
  const feed = useRef<HTMLOListElement>(null);

  // Keep the newest message in view when the channel changes or a message arrives.
  useEffect(() => {
    const el = feed.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [channel.id, messages.length]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setError('');
    try {
      await post({ channelId: channel.id, authorKind: 'user', authorId: me, kind: 'chat', body, meta: '{}' });
      setDraft('');
    } catch (err) {
      setError(`Not sent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) void send(e);
  }

  async function newThread(e: FormEvent) {
    e.preventDefault();
    const name = (threadName ?? '').trim();
    if (!name) return;
    setError('');
    try {
      await createChannel({ name, kind: 'thread', parentId: channel.id });
      setThreadName(null);
    } catch (err) {
      setError(`Thread not created: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const canThread = channel.kind === 'public';

  return (
    <section className="chat" aria-label={title}>
      {(parent || canThread) && (
        <div className="chat-threads">
          {parent && (
            <button type="button" className="chip" onClick={() => onOpen(parent.id)}>
              ← # {parent.name}
            </button>
          )}
          {canThread && (
            <>
              <span className="chat-threads-label">Threads</span>
              {threads.map(t => (
                <button key={String(t.id)} type="button" className="chip" onClick={() => onOpen(t.id)}>
                  {t.name}
                </button>
              ))}
              {threadName === null ? (
                <button type="button" className="chip chip-add" onClick={() => setThreadName('')}>
                  New thread
                </button>
              ) : (
                <form className="thread-form" onSubmit={newThread}>
                  <label className="sr-only" htmlFor="thread-name">
                    Thread name
                  </label>
                  <input
                    id="thread-name"
                    name="thread-name"
                    autoComplete="off"
                    maxLength={80}
                    value={threadName}
                    onChange={e => setThreadName(e.target.value)}
                    placeholder="What's it about…"
                    autoFocus
                  />
                  <button type="submit">Create</button>
                  <button type="button" onClick={() => setThreadName(null)}>
                    Cancel
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      )}

      <ol className="chat-feed" ref={feed} aria-live="polite" aria-relevant="additions">
        {messages.length === 0 && (
          <li className="chat-empty">
            No messages in {title} yet. Say hello, or mention a REMi with <code>@name</code> to wake it.
          </li>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const grouped =
            !!prev &&
            prev.authorKind === m.authorKind &&
            prev.authorId === m.authorId &&
            m.kind === 'chat' &&
            prev.kind === 'chat' &&
            Number((m.ts.microsSinceUnixEpoch - prev.ts.microsSinceUnixEpoch) / 1000n) < GROUP_MS;
          return <MessageItem key={String(m.id)} m={m} author={authorOf(m, users, agents)} grouped={grouped} />;
        })}
      </ol>

      <form className="composer" onSubmit={send}>
        <label className="sr-only" htmlFor="composer">
          Message {title}
        </label>
        <textarea
          id="composer"
          name="message"
          rows={1}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={`Message ${title}…`}
          autoComplete="off"
        />
        <button type="submit" className="btn-primary" disabled={!connected || !draft.trim()}>
          Send
        </button>
        <p className="composer-hint">
          {connected ? (
            <>
              <kbd>Enter</kbd> sends · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · <code>@name</code> wakes a REMi
            </>
          ) : (
            'Reconnecting…'
          )}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
