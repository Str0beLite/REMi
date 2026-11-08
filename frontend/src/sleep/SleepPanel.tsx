import { cronLabel } from '../config/configData';
import { RemiAvatar } from '../components/RemiAvatar';
import { useState } from 'react';
import Markdown from 'react-markdown';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import { LossChart } from './LossChart';
import { sleepState } from './sleepData';
import './sleep.css';

const PHASE_LABEL: Record<string, string> = {
  night: 'Night: Sleep REMi is reviewing the day',
  asleep: 'Asleep: getting ready to train',
  training: 'Training',
  wake: 'Waking up',
  report: 'Awake',
};

// The REM cycle: Sleep now, the live loss curve, and the wake report.
export function SleepPanel() {
  const { identity } = useSpacetimeDB();
  const [messages] = useTable(tables.message);
  const [users] = useTable(tables.user);
  const [settings] = useTable(tables.setting);
  const requestSleep = useReducer(reducers.requestSleep);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const isAdmin = users.find(u => identity && u.identity.isEqual(identity))?.isAdmin === true;
  const s = sleepState(messages);
  const cron = settings.find(x => x.key === 'sleep_cron')?.value;
  const when = s.lastEvent ? new Date(Number(s.lastEvent.ts.microsSinceUnixEpoch / 1000n)).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : undefined;
  const sleeping = s.phase === 'night' || s.phase === 'asleep' || s.phase === 'training';

  async function sleepNow() {
    setBusy(true);
    setError('');
    try {
      await requestSleep();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sleep-panel">
      <section className="sleep-status">
        <RemiAvatar status={sleeping ? 'asleep' : 'idle'} headgear="nightcap" size={44} />
        <div>
          <h2>{s.phase ? (PHASE_LABEL[s.phase] ?? s.phase) : 'Awake'}</h2>
          <p>
            {when ? `Last event ${when}` : 'No sleep yet.'}
            {s.spec && <> · spec <code>{s.spec}</code></>}
            {cron && (
              <>
                {' '}
                · sleeps {cronLabel(cron) || <code>{cron}</code>}
              </>
            )}
          </p>
        </div>
        {isAdmin && (
          <button type="button" className="btn-primary" onClick={sleepNow} disabled={busy || sleeping}>
            {sleeping ? 'Sleeping…' : busy ? 'Requesting…' : 'Sleep now'}
          </button>
        )}
      </section>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <section>
        <h3>Training loss</h3>
        <LossChart points={s.points} label={s.spec ? `Loss for ${s.spec}` : 'Loss'} />
      </section>
      <section>
        <h3>Wake report</h3>
        {s.report ? (
          <div className="sleep-report msg-md">
            <Markdown>{s.report.body}</Markdown>
          </div>
        ) : (
          <p className="chart-empty">The report appears here when Sleep REMi wakes up.</p>
        )}
      </section>
    </div>
  );
}
