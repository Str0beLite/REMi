import Markdown from 'react-markdown';
import { RemiAvatar } from '../components/RemiAvatar';
import { defaultLook, type AgentStatus } from '../components/remiLook';
import type { Message } from '../module_bindings/types';
import { timeLabel, type Author } from './model';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map(p => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

function Avatar({ author }: { author: Author }) {
  if (author.kind === 'agent' && author.agent) {
    const look = defaultLook(author.agent);
    return <RemiAvatar status={author.agent.status as AgentStatus} headgear={look.headgear} tint={look.tint} size={32} />;
  }
  return (
    <span className={`msg-initials${author.kind === 'system' ? ' is-system' : ''}`} aria-hidden="true">
      {author.kind === 'system' ? 'R' : initials(author.name)}
    </span>
  );
}

const CARD_LABEL: Record<string, string> = {
  tool_card: 'Tool proposal',
  adapter_event: 'Adapter',
  sleep_event: 'Sleep',
  help_request: 'Help request',
  system: 'System',
};

function Body({ m }: { m: Message }) {
  if (m.kind === 'chat') {
    return (
      <div className="msg-md">
        <Markdown>{m.body}</Markdown>
      </div>
    );
  }
  if (m.kind === 'tool_call' || m.kind === 'tool_result') {
    const first = m.body.split('\n')[0];
    return (
      <details className="msg-call">
        <summary>
          <span className="msg-call-kind">{m.kind === 'tool_call' ? 'call' : 'result'}</span>
          <code>{first || '(empty)'}</code>
        </summary>
        <pre>{m.body}</pre>
      </details>
    );
  }
  // tool_card / adapter_event / sleep_event get their rich cards in #13 and #14.
  return (
    <div className="msg-card">
      <span className="msg-card-kind">{CARD_LABEL[m.kind] ?? m.kind}</span>
      <p>{m.body}</p>
    </div>
  );
}

export function MessageItem({ m, author, grouped }: { m: Message; author: Author; grouped: boolean }) {
  return (
    <li className={`msg${grouped ? ' is-grouped' : ''}`}>
      <div className="msg-gutter">{!grouped && <Avatar author={author} />}</div>
      <div className="msg-main">
        {!grouped && (
          <div className="msg-who">
            <b>{author.name}</b>
            {author.kind === 'agent' && <span className="msg-tag">REMi</span>}
            <time className="msg-time mono">{timeLabel(m)}</time>
          </div>
        )}
        <Body m={m} />
      </div>
    </li>
  );
}
