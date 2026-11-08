// Which LoRAs ("skills") a REMi living on `home` may use, mirroring attach_adapter (CONTRACT.md §4):
// adopted, trained on the home's base model, and with its files on that node (trained there or copied there).
export type Skill = { name: string; version: number; description: string };

type AdapterRow = Skill & { key: string; status: string; base: string; nodeId: bigint };

export function usableSkills(
  adapters: readonly AdapterRow[],
  copies: readonly { key: string; nodeId: bigint }[],
  home: { id: bigint; baseModel: string } | undefined,
): Skill[] {
  if (!home) return [];
  return adapters
    .filter(a => a.status === 'adopted' && a.base === home.baseModel && (a.nodeId === home.id || copies.some(c => c.key === a.key && c.nodeId === home.id)))
    .map(({ name, version, description }) => ({ name, version, description }))
    .sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version);
}
