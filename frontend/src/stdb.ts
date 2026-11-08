// SpacetimeDB connection settings. Override with VITE_STDB_URI / VITE_STDB_DB in frontend/.env.local.
import { DbConnection } from './module_bindings';

export const STDB_URI: string = import.meta.env.VITE_STDB_URI ?? 'wss://maincloud.spacetimedb.com';
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

export const connectionBuilder = () =>
  DbConnection.builder()
    .withUri(STDB_URI)
    .withDatabaseName(STDB_DB)
    .withToken(readToken())
    .withAutomaticReconnect()
    .onConnect((_conn, _identity, token) => writeToken(token));
