// agent_card meta is `{"proposal_id": n}` (CONTRACT.md §6).
export function proposalIdOf(meta: string): bigint | undefined {
  try {
    const v = (JSON.parse(meta) as { proposal_id?: unknown }).proposal_id;
    return typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)) ? BigInt(v) : undefined;
  } catch {
    return undefined;
  }
}
