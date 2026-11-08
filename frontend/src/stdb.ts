// SpacetimeDB connection settings. Override with VITE_STDB_URI / VITE_STDB_DB in frontend/.env.local.
// `same-host` (the Docker console's default) means this page's own host on port 3000, so a browser on another
// machine reaches the workspace it loaded the console from instead of its own localhost (#83).
import { DbConnection } from './module_bindings';

const configured: string = import.meta.env.VITE_STDB_URI ?? 'wss://maincloud.spacetimedb.com';
export const STDB_URI: string =
  configured === 'same-host' ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:3000` : configured;
export const STDB_DB: string = import.meta.env.VITE_STDB_DB ?? 'remi';

const TOKEN_KEY = `${STDB_URI}/${STDB_DB}/auth_token`;

// The browser keeps its SpacetimeDB identity in localStorage, so a returning visitor keeps their nickname.
function readToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private mode: the identity lasts for this tab only.
  }
}

// A token signed by another server (the workspace was wiped or re-created on the same port) gets 401 forever and the
// console hangs on "Connecting". Drop it only when the server says it's invalid, never on a plain network error.
async function dropRejectedToken() {
  const token = readToken();
  if (!token) return;
  try {
    const res = await fetch(`${STDB_URI.replace(/^ws/, 'http')}/v1/identity/websocket-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 401) return;
    localStorage.removeItem(TOKEN_KEY);
    location.reload();
  } catch {
    // Server unreachable: keep the token and let the reconnect retry.
  }
}

export const connectionBuilder = () =>
  DbConnection.builder()
    .withUri(STDB_URI)
    .withDatabaseName(STDB_DB)
    .withToken(readToken())
    .withAutomaticReconnect()
    .onConnect((_conn, _identity, token) => writeToken(token))
    .onConnectError(() => void dropRejectedToken());
