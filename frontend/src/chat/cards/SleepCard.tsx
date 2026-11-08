import Markdown from 'react-markdown';
import { LossChart } from '../../sleep/LossChart';
import { sleepMeta, type LossPoint } from '../../sleep/sleepData';
import '../../sleep/sleep.css';

// One card per sleep's training: the loss curve grows in place as updates arrive, instead of one line per update.
export function TrainingCard({ last, points }: { last: { meta: string; body: string }; points: LossPoint[] }) {
  const m = sleepMeta(last.meta);
  const now = points.at(-1);
  return (
    <div className="sleep-card is-training">
      <span className="sleep-card-phase">Training</span>
      <span>
        {m.spec ?? 'adapter'}
        {now && (
          <span className="sleep-card-loss mono">
            {' '}
            step {now.step}, loss {now.loss.toFixed(3)}
          </span>
        )}
      </span>
      <LossChart points={points} label={`Training ${m.spec ?? ''}`.trim()} />
    </div>
  );
}

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
