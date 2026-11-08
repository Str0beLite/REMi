import { useState, type FormEvent } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../module_bindings';
import { RemiAvatar } from '../components/RemiAvatar';

// First visit: what this workspace is, and the name others see in chat. No password; the browser keeps its identity.
// Opened from a `remi up` admin link, it says so; the claim itself runs right after the name is saved (useAdminClaim).
export function NicknamePrompt({ workspace, adminLink }: { workspace: string; adminLink: boolean }) {
  const setNickname = useReducer(reducers.setNickname);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await setNickname({ nickname: name.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="nick">
      <form className="nick-card" onSubmit={submit} aria-labelledby="welcome-title">
        <RemiAvatar status="idle" size={56} />
        <h1 id="welcome-title">Welcome to REMi</h1>
        <p className="nick-workspace">
          Workspace <span className="mono">{workspace}</span>
        </p>
        <p>Agents that run on your team's GPUs, work alongside you in channels, and learn from the day overnight.</p>
        {adminLink && (
          <p className="nick-admin" role="note">
            <b>This link makes you the admin of this workspace.</b> You'll approve tools, adapters and new REMis. The link works once.
          </p>
        )}
        <label htmlFor="nickname">Your name</label>
        <input
          id="nickname"
          name="nickname"
          autoComplete="nickname"
          spellCheck={false}
          maxLength={24}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Priya…"
          autoFocus
          required
          pattern=".*\S.*"
          title="Use at least one letter or number"
        />
        <p className="nick-hint">People and REMis see this in chat. You can change it later in Config.</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Joining…' : adminLink ? 'Join as admin' : 'Join'}
        </button>
      </form>
    </div>
  );
}
