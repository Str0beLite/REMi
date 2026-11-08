import Markdown from 'react-markdown';
import { sleepMeta } from '../../sleep/sleepData';
import '../../sleep/sleep.css';

const PHASE: Record<string, string> = { night: 'Night', asleep: 'Asleep', training: 'Training', wake: 'Awake', report: 'Wake report' };

// sleep_event: a compact line per phase; training steps show step and loss, reports render as markdown.
export function SleepCard({ meta, body }: { meta: string; body: string }) {
  const m = sleepMeta(meta);
  return (
    <div className={`sleep-card phase-${m.phase ?? 'unknown'}`}>
      <span className="sleep-card-phase">{(m.phase && PHASE[m.phase]) ?? 'Sleep'}</span>
      {m.phase === 'report' ? (
        <div className="msg-md">
          <Markdown>{body}</Markdown>
        </div>
      ) : (
        <span>
          {body}
          {m.phase === 'training' && typeof m.loss === 'number' && <span className="sleep-card-loss mono"> loss {m.loss.toFixed(3)}</span>}
        </span>
      )}
    </div>
  );
}
