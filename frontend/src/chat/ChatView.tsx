import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../module_bindings';
import type { Agent, Channel, Message, User } from '../module_bindings/types';
import { RemiAvatar } from '../components/RemiAvatar';
import { defaultLook, type AgentStatus } from '../components/remiLook';
import { MessageItem } from './MessageItem';
import { ToolRun } from './ToolRun';
import { TrainingCard } from './cards/SleepCard';
import { authorOf, feedItems, hexOf, mentionMatches, mentionQuery, mentionsName, purposeOf, type MentionOption } from './model';
import { useUpload } from '../files/useUpload';
import { MAX_UPLOAD } from '../files/upload';
import { sizeLabel } from '../files/fsResult';
import '../files/files.css';

type Props = {
  top?: ReactNode; // onboarding notices above the feed
  channel: Channel;
  title: string;
  messages: readonly Message[];
  users: readonly User[];
  agents: readonly Agent[];
  me: string;
  connected: boolean;
};

const GROUP_MS = 5 * 60 * 1000;

export function ChatView({ top, channel, title, messages, users, agents, me, connected }: Props) {
  const post = useReducer(reducers.postMessage);
  // One draft per channel, so switching channels doesn't carry half a message along.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = String(channel.id);
  const draft = drafts[draftKey] ?? '';
  const setDraft = (v: string) => setDrafts(d => ({ ...d, [draftKey]: v }));
  const [error, setError] = useState('');
  const feed = useRef<HTMLOListElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [pick, setPick] = useState(0);
  // Esc closes the menu for this @ only; typing a new @ opens it again.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const options = mention && mention.start !== dismissed ? mentionMatches(mention.query, agents, users, me) : [];
  const menuOpen = options.length > 0;

  // Follow new messages only while the reader is at the bottom (or just sent one);
  // someone scrolled up into history stays where they are.
  const pinned = useRef(true);
  // id of the newest message the reader has seen at the bottom; anything newer (not theirs) is unseen
  const [readTo, setReadTo] = useState<bigint>();
  useEffect(() => {
    pinned.current = true;
    const el = feed.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [channel.id]);
  const last = messages.at(-1);
  const items = feedItems(messages);
  useEffect(() => {
    const el = feed.current;
    if (!el || !last) return;
    if (pinned.current || (last.authorKind === 'user' && last.authorId === me)) {
      el.scrollTop = el.scrollHeight;
      setReadTo(last.id);
    }
    // keyed on the id, not the row object, so only a genuinely new message counts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id, me]);
  const unseen = readTo === undefined ? 0 : messages.filter(m => m.id > readTo && !(m.authorKind === 'user' && m.authorId === me)).length;
  const toBottom = () => {
    const el = feed.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const myRow = users.find(u => hexOf(u.identity) === me);
  const myName = myRow?.nickname;

  // A file picked or dropped waits here for its REMi (#98); the first @mentioned one is the default.
  const [attached, setAttached] = useState<File>();
  const [attachTo, setAttachTo] = useState('');
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const { upload, status, clear } = useUpload();
  const agentsByName = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  function attach(file: File | undefined) {
    if (!file) return;
    clear();
    setAttached(file);
    setAttachTo(String(agentsByName.find(a => mentionsName(draft, a.name))?.id ?? ''));
  }
  async function sendAttached() {
    const to = agents.find(a => String(a.id) === attachTo);
    if (attached && to && (await upload(attached, to.id, to.name, channel.id))) setAttached(undefined);
  }

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

  // Re-read the @query whenever the text or caret moves.
  function track(el: HTMLTextAreaElement) {
    const q = el.selectionStart === el.selectionEnd ? mentionQuery(el.value, el.selectionStart) : null;
    setMention(prev => (prev?.start === q?.start && prev?.query === q?.query ? prev : q));
    // functional: onSelect can fire in the same batch as the Esc that set it
    setDismissed(d => (q?.start === d ? d : null));
    if (q?.query !== mention?.query) setPick(0);
  }

  function choose(o: MentionOption) {
    const el = box.current;
    if (!el || !mention) return;
    const end = mention.start + 1 + mention.query.length;
    const insert = `@${o.name} `;
    setDraft(draft.slice(0, mention.start) + insert + draft.slice(end));
    setMention(null);
    const caret = mention.start + insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setPick(p => (p + step + options.length) % options.length);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        choose(options[Math.min(pick, options.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(mention!.start);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) void send(e);
  }

  return (
    <section
      className={`chat${dragging ? ' chat-drag' : ''}`}
      aria-label={title}
      onDragOver={e => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={e => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={e => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        attach(e.dataTransfer.files[0]);
      }}
    >
      {top}
      <div className="chat-feed-wrap">
      <ol
        className="chat-feed"
        ref={feed}
        aria-live="polite"
        aria-relevant="additions"
        onScroll={e => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (pinned.current && last) setReadTo(last.id);
        }}
      >
        {messages.length === 0 && (
          <li className="chat-empty">
            <RemiAvatar status="idle" size={56} />
            <p>
              No messages in {title} yet. Say hello, or mention a REMi with <code>@name</code> to wake it.
            </p>
          </li>
        )}
        {items.map((item, i) => {
          const m = item.kind === 'msg' ? item.m : item.first;
          const prev = items[i - 1];
          const lastStep = prev?.kind === 'tools' ? prev.steps.at(-1) : undefined;
          const p = prev && (prev.kind === 'msg' ? prev.m : (lastStep?.result ?? lastStep?.call ?? prev.first));
          // chat and tool runs from the same author within 5 minutes share one header; cards keep theirs
          const flows = (x: typeof item) => x.kind === 'tools' || (x.kind === 'msg' && x.m.kind === 'chat');
          const grouped =
            !!p &&
            p.authorKind === m.authorKind &&
            p.authorId === m.authorId &&
            flows(item) &&
            flows(prev) &&
            Number((m.ts.microsSinceUnixEpoch - p.ts.microsSinceUnixEpoch) / 1000n) < GROUP_MS;
          return (
            <MessageItem
              key={String(m.id)}
              m={m}
              author={authorOf(m, users, agents)}
              grouped={grouped}
              mentionsMe={!!myName && m.authorId !== me && item.kind === 'msg' && mentionsName(m.body, myName)}
            >
              {item.kind === 'tools' ? (
                <ToolRun steps={item.steps} />
              ) : item.kind === 'training' ? (
                <TrainingCard last={item.last} points={item.points} done={item.done} canStop={!!myRow?.isAdmin} />
              ) : undefined}
            </MessageItem>
          );
        })}
      </ol>
        {unseen > 0 && (
          <button type="button" className="chat-unseen" onClick={toBottom}>
            {unseen} new {unseen === 1 ? 'message' : 'messages'} ↓
          </button>
        )}
      </div>

      <form className="composer" onSubmit={send}>
        <label className="sr-only" htmlFor="composer">
          Message {title}
        </label>
        {menuOpen && (
          <ul className="mention-menu" id="mention-menu" role="listbox" aria-label="Mention">
            {options.map((o, i) => {
              const status = o.kind === 'agent' ? (o.agent.status as AgentStatus) : null;
              const purpose = o.kind === 'agent' ? purposeOf(o.agent.agentfile) : '';
              return (
                <li
                  key={`${o.kind}:${o.name}`}
                  id={`mention-${i}`}
                  role="option"
                  aria-selected={i === pick}
                  className="mention-opt"
                  // mousedown, not click: keeps focus (and the caret) in the composer
                  onMouseDown={e => {
                    e.preventDefault();
                    choose(o);
                  }}
                  onMouseEnter={() => setPick(i)}
                >
                  {o.kind === 'agent' ? (
                    <RemiAvatar status={status!} {...defaultLook(o.agent)} size={24} />
                  ) : (
                    <span className="mention-initial" aria-hidden="true">
                      {o.name.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="mention-name">@{o.name}</span>
                  {status && <span className={`mention-status status-${status}`}>{status}</span>}
                  {purpose && <span className="mention-purpose">{purpose}</span>}
                </li>
              );
            })}
          </ul>
        )}
        <textarea
          id="composer"
          ref={box}
          name="message"
          rows={1}
          value={draft}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? 'mention-menu' : undefined}
          aria-activedescendant={menuOpen ? `mention-${Math.min(pick, options.length - 1)}` : undefined}
          onChange={e => {
            setDraft(e.target.value);
            track(e.target);
          }}
          onSelect={e => track(e.currentTarget)}
          onBlur={() => setMention(null)}
          onKeyDown={onKey}
          placeholder={`Message ${title}…`}
          autoComplete="off"
        />
        <input
          ref={picker}
          type="file"
          hidden
          onChange={e => {
            attach(e.target.files?.[0]);
            e.target.value = ''; // picking the same file again still works
          }}
        />
        <button type="button" className="composer-attach-btn" onClick={() => picker.current?.click()} disabled={!connected || agents.length === 0}>
          Attach…
        </button>
        <button type="submit" className="btn-primary" disabled={!connected || !draft.trim()}>
          Send
        </button>
        {attached && (
          <div className="composer-attach" role="group" aria-label="Upload a file to a REMi">
            <span>
              <code>{attached.name}</code> ({sizeLabel(attached.size)}) to
            </span>
            <label className="sr-only" htmlFor="attach-to">
              REMi to send it to
            </label>
            <select id="attach-to" name="attach-to" value={attachTo} onChange={e => setAttachTo(e.target.value)}>
              <option value="">Pick a REMi…</option>
              {agentsByName.map(a => (
                <option key={String(a.id)} value={String(a.id)}>
                  {a.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void sendAttached()} disabled={!attachTo || status.busy || attached.size > MAX_UPLOAD}>
              Upload to /shared
            </button>
            <button type="button" onClick={() => setAttached(undefined)} disabled={status.busy}>
              Cancel
            </button>
            {attached.size > MAX_UPLOAD && <span className="form-error">Over 50 MB, too big to upload.</span>}
          </div>
        )}
        {status.text && (
          <p className={status.error ? 'form-error' : 'composer-hint'} role="status">
            {status.text}
          </p>
        )}
        <p className="composer-hint">
          {connected ? (
            <>
              <span className="composer-keys">
                <kbd>Enter</kbd> sends · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line ·{' '}
              </span>
              <code>@name</code> wakes a REMi
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
