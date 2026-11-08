import { useState } from 'react';
import type { Claim } from '../admin/claim';
import type { Step } from './steps';
import './onboarding.css';

const storageKey = (workspace: string) => `remi:${workspace}:get-started-hidden`;

function readHidden(workspace: string) {
  try {
    return localStorage.getItem(storageKey(workspace)) === '1';
  } catch {
    return false;
  }
}

function Check({ done }: { done: boolean }) {
  return (
    <svg className={`gs-check${done ? ' is-done' : ''}`} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill={done ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" />
      {done && <path d="M4.8 8.2l2.1 2.1 4.3-4.6" fill="none" stroke="var(--surface)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

// Shown in #general until a REMi has replied or the viewer hides it. Each step is real work in the product, not a tour.
export function GetStarted({ workspace, steps, onCreateRemi }: { workspace: string; steps: Step[]; onCreateRemi: () => void }) {
  const [hidden, setHidden] = useState(() => readHidden(workspace));
  if (hidden || steps.every(s => s.done)) return null;
  const next = steps.find(s => !s.done)?.id;

  function hide() {
    setHidden(true);
    try {
      localStorage.setItem(storageKey(workspace), '1');
    } catch {
      /* private mode: it just comes back next visit */
    }
  }

  return (
    <section className="gs" aria-labelledby="gs-title">
      <header className="gs-head">
        <h2 id="gs-title">Get started</h2>
        <span className="gs-count">
          {steps.filter(s => s.done).length} of {steps.length} done
        </span>
        <button type="button" className="gs-hide" onClick={hide}>
          Hide
        </button>
      </header>
      <ol className="gs-steps">
        {steps.map(s => (
          <li key={s.id} className={`gs-step${s.done ? ' is-done' : ''}${s.id === next ? ' is-next' : ''}`}>
            <Check done={s.done} />
            <span className="gs-text">
              {s.text}
              <span className="sr-only">{s.done ? ' (done)' : ' (to do)'}</span>
            </span>
            {s.id === 'remi' && !s.done && (
              <button type="button" className={s.id === next ? 'btn-primary' : undefined} onClick={onCreateRemi}>
                Create a REMi
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// After an admin link: say what happened, once, in the place the user lands.
export function ClaimNotice({ claim, workspace, isAdmin, onDismiss }: { claim: Claim; workspace: string; isAdmin: boolean; onDismiss: () => void }) {
  if (claim.state !== 'done' && claim.state !== 'failed') return null;
  const ok = claim.state === 'done';
  return (
    <p className={`claim-note${ok ? '' : ' is-failed'}`} role="status">
      <span>
        {ok ? (
          <>
            You're the admin of <span className="mono">{workspace}</span>. Approvals and runtime settings are yours.
          </>
        ) : (
          <>
            {/already used|not valid/.test(claim.error ?? '') ? "That admin link was already used or isn't valid." : `The admin link didn't work: ${claim.error}.`}{' '}
            {isAdmin ? "You're still an admin." : "You're in as a member; ask an admin for a new link."}
          </>
        )}
      </span>
      <button type="button" className="gs-hide" onClick={onDismiss}>
        Dismiss
      </button>
    </p>
  );
}
