import { useState, type FormEvent } from 'react';
import { RemiAvatar } from '../components/RemiAvatar';
import { joinCluster } from './setupApi';
import './nodes.css';

// First stop on a fresh machine (#83): `remi up` printed an admin link; opening it asks whether this machine starts a
// new cluster (then the usual welcome: your name, admin) or joins an existing one with a join link from that cluster.
export function Onboarding({ claim, onNewCluster }: { claim: string; onNewCluster: () => void }) {
  const [joining, setJoining] = useState(false);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function join(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const cluster = await joinCluster(link, claim);
      location.replace(cluster); // one console per cluster: this machine's own only did onboarding
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="nick">
      {!joining ? (
        <section className="nick-card onboard" aria-labelledby="onboard-title">
          <RemiAvatar status="idle" size={56} />
          <h1 id="onboard-title">Set up this machine</h1>
          <p>REMi is running here. Start a new cluster on this machine, or add it to a cluster you already have.</p>
          <div className="onboard-choices">
            <button type="button" className="onboard-choice" onClick={onNewCluster}>
              <b>Start a new cluster</b>
              <span>This machine hosts the workspace. You'll be its admin and can add more machines later.</span>
            </button>
            <button type="button" className="onboard-choice" onClick={() => setJoining(true)}>
              <b>Join an existing cluster</b>
              <span>Paste the join link from that cluster's Config &gt; Add a machine. Its REMis can then run here.</span>
            </button>
          </div>
        </section>
      ) : (
        <form className="nick-card onboard" onSubmit={join} aria-labelledby="onboard-join-title">
          <RemiAvatar status="idle" size={56} />
          <h1 id="onboard-join-title">Join an existing cluster</h1>
          <p>
            On a machine already in the cluster, open its console as an admin: Config &gt; Add a machine &gt; Allow machines to join.
            Copy the link and paste it here.
          </p>
          <label htmlFor="join-link">Join link</label>
          <input
            id="join-link"
            name="join-link"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={link}
            onChange={e => setLink(e.target.value)}
            placeholder="http://192.168.1.20:8080/?join=…"
            autoFocus
            required
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="onboard-actions">
            <button type="button" onClick={() => setJoining(false)} disabled={busy}>
              Back
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Joining…' : 'Join cluster'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// A join link opened in a browser lands on the cluster's console: say where it belongs instead of a blank sign-in.
export function JoinLinkHelp() {
  return (
    <div className="nick">
      <section className="nick-card onboard" aria-labelledby="joinhelp-title">
        <RemiAvatar status="idle" size={56} />
        <h1 id="joinhelp-title">This is a join link</h1>
        <p>It adds a machine to this cluster. Paste it on the new machine, not here:</p>
        <ol className="onboard-steps">
          <li>
            On the new machine, run <code>scripts/remi up</code>.
          </li>
          <li>Open the link it prints and choose Join an existing cluster.</li>
          <li>Paste this page's address there.</li>
        </ol>
      </section>
    </div>
  );
}
