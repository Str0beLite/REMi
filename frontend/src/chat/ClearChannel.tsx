import { useState } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../module_bindings';
import type { Channel } from '../module_bindings/types';
import { clearQuestion } from './model';

// Admin-only Clear channel (trash icon) in the chat header: confirm, call clear_channel, show a refusal inline.
// App keys it by channel, so an error doesn't follow you to the next channel.
export function ClearChannel({ channel, title }: { channel: Channel; title: string }) {
  const clear = useReducer(reducers.clearChannel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run() {
    if (!window.confirm(clearQuestion(channel, title))) return;
    setBusy(true);
    setError('');
    try {
      await clear({ channelId: channel.id });
    } catch (err) {
      setError(`Not cleared: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
      <button
        type="button"
        className="clear-channel"
        aria-label="Clear channel"
        title="Clear channel"
        aria-busy={busy}
        disabled={busy}
        onClick={run}
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
        </svg>
      </button>
    </>
  );
}
