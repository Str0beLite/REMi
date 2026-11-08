// Admin claim links (CONTRACT.md §4 claim_admin): `remi up` prints `<console>/?claim=<code>`. Opening it makes the
// browser's identity admin once it has a user row, then the code leaves the URL so a reload or a shared link can't reuse it.
import { useEffect, useRef, useState } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../module_bindings';

const PARAM = 'claim';

export const readClaim = (search: string) => new URLSearchParams(search).get(PARAM)?.trim() || undefined;

// The same URL without ?claim=, keeping the path, other params and the hash.
export function withoutClaim(href: string) {
  const u = new URL(href);
  u.searchParams.delete(PARAM);
  return u.pathname + u.search + u.hash;
}

export type Claim = { state: 'none' | 'pending' | 'claiming' | 'done' | 'failed'; error?: string };

// `pending` while there is a code but no user row yet (the nickname step shows it), then claims once.
export function useAdminClaim(hasUser: boolean): Claim {
  const [code] = useState(() => readClaim(location.search));
  const [claim, setClaim] = useState<Claim>({ state: code ? 'pending' : 'none' });
  const claimAdmin = useReducer(reducers.claimAdmin);
  const sent = useRef(false);

  useEffect(() => {
    if (!code || !hasUser || sent.current) return;
    sent.current = true;
    setClaim({ state: 'claiming' });
    history.replaceState(history.state, '', withoutClaim(location.href));
    claimAdmin({ code }).then(
      () => setClaim({ state: 'done' }),
      (err: unknown) => setClaim({ state: 'failed', error: err instanceof Error ? err.message : String(err) }),
    );
  }, [code, hasUser, claimAdmin]);

  return claim;
}

// 18 random bytes as base64url: 24 chars of [A-Za-z0-9_-], inside add_admin_code's 16-64 rule.
export function newAdminCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

export const adminLinkFor = (code: string, href = location.href) => {
  const u = new URL(href);
  u.hash = '';
  u.search = `?claim=${code}`;
  return u.toString();
};
