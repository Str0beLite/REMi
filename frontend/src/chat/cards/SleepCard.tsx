import { useState } from 'react';
import Markdown from 'react-markdown';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../../module_bindings';
import { LossChart } from '../../sleep/LossChart';
import { sleepMeta, type LossPoint } from '../../sleep/sleepData';
import '../../sleep/sleep.css';

type TrainingProps = { last: { meta: string; body: string }; points: LossPoint[]; done: boolean; canStop: boolean };

// One card per sleep's training: the loss curve grows in place as updates arrive, instead of one line per update.
// Admins can stop a running one (setting train_stop, CONTRACT §3): training ends after the current step and the adapter it has so far is kept as a candidate.
export function TrainingCard({ last, points, done, canStop }: TrainingProps) {
  const m = sleepMeta(last.meta);
  const now = points.at(-1);
  const setSetting = useReducer(reducers.setSetting);
  const [stop, setStop] = useState<'idle' | 'sending' | 'sent' | string>('idle');

  async function onStop() {
    if (!m.spec || !confirm(`Stop training ${m.spec} now? It keeps what it has learned so far as a candidate, and everyone wakes up.`)) return;
    setStop('sending');
    try {
      await setSetting({ key: 'train_stop', value: `${m.spec}@${Math.floor(Date.now() / 1000)}` });
      setStop('sent');
    } catch (err) {
      setStop(`Couldn't stop: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className="sleep-card is-training">
      <div className="sleep-card-head">
        <span className="sleep-card-phase">{done ? 'Trained' : 'Training'}</span>
        <span>
          {m.spec ?? 'adapter'}
          {now && (
            <span className="sleep-card-loss mono">
              {' '}
              step {now.step}, loss {now.loss.toFixed(3)}
            </span>
          )}
        </span>
        {canStop && !done && m.spec && (
          <button type="button" className="sleep-card-stop" onClick={onStop} disabled={stop === 'sending' || stop === 'sent'}>
            {stop === 'sent' ? 'Stopping…' : 'Stop and keep'}
          </button>
        )}
      </div>
      {stop.startsWith("Couldn't") && (
        <p className="form-error" role="alert">
          {stop}
        </p>
      )}
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
