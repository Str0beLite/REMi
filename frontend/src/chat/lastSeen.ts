// The newest message this browser has seen per channel, kept across reloads so unread badges don't start over.
// Per browser and per workspace, like the sign-in token; private mode or blocked storage just means it lasts the tab.
import { STDB_DB, STDB_URI } from '../stdb';

const key = () => `${STDB_URI}/${STDB_DB}/last_seen`;

export function loadLastSeen(): Record<string, bigint> {
  try {
    const raw = JSON.parse(localStorage.getItem(key()) ?? '{}') as Record<string, string>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => /^\d+$/.test(v)).map(([k, v]) => [k, BigInt(v)]));
  } catch {
    return {};
  }
}

export function saveLastSeen(seen: Record<string, bigint>) {
  try {
    localStorage.setItem(key(), JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, String(v)]))));
  } catch {
    // storage blocked: the badges reset on reload, as before
  }
}
