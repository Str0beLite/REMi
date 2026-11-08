// What the module accepts for a public channel: a-z, 0-9 and -, 1-32 characters (CONTRACT.md §4 create_channel).
export const channelSlug = (raw: string) =>
  raw
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '');
