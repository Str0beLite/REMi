import { useState, type FormEvent } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../module_bindings';

// First visit: pick the name others see in chat. No password; the browser keeps its identity.
export function NicknamePrompt() {
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
      <form className="nick-card" onSubmit={submit}>
        <h1>Welcome to REMi</h1>
        <p>Pick the name people and REMis will see in chat. You can change it later.</p>
        <label htmlFor="nickname">Nickname</label>
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
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Joining…' : 'Join'}
        </button>
      </form>
    </div>
  );
}
