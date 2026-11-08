// This machine's node, reached through the console's own web server (/setup/ -> node, backend/runtime/remi/setup.py).

// The cluster console this machine joined, or null. Any failure (an old node, `npm run dev` with no node) means "not joined".
export async function clusterStatus(): Promise<string | null> {
  try {
    const res = await fetch('/setup/status');
    if (!res.ok) return null;
    const body = (await res.json()) as { cluster?: string | null };
    return body.cluster ?? null;
  } catch {
    return null;
  }
}

// Point this machine's node at the cluster in `link`. `claim` is the one-time admin code from `remi up`'s link, which
// proves the person is at this machine. Resolves to the cluster console's URL; rejects with a message to show.
export async function joinCluster(link: string, claim: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch('/setup/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link: link.trim(), claim }),
    });
  } catch {
    throw new Error("Can't reach this machine's node. Check scripts/remi status, then try again.");
  }
  const body = (await res.json().catch(() => ({}))) as { cluster?: string; error?: string };
  if (!res.ok || !body.cluster) throw new Error(body.error ?? `This machine's node answered ${res.status}. Check scripts/remi logs.`);
  return body.cluster;
}
