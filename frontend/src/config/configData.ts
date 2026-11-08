// Validation and node health for the config page.

const CRON_FIELDS: [string, number, number][] = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day of month', 1, 31],
  ['month', 1, 12],
  ['day of week', 0, 7],
];

// Standard 5-field cron: each field is *, */n, n, a-b, a-b/n, or a comma list of those. Returns an error or ''.
export function cronError(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return 'Cron needs 5 fields: minute hour day month weekday, e.g. "0 3 * * *".';
  for (let i = 0; i < 5; i++) {
    const [name, lo, hi] = CRON_FIELDS[i];
    for (const item of parts[i].split(',')) {
      const m = item.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
      if (!m) return `The ${name} field "${parts[i]}" isn't valid cron.`;
      const nums = [m[2], m[3]].filter(Boolean).map(Number);
      if (nums.some(n => n < lo || n > hi)) return `The ${name} field must be between ${lo} and ${hi}.`;
      if (nums.length === 2 && nums[0] > nums[1]) return `The ${name} range "${item}" runs backwards.`;
      if (m[4] !== undefined && Number(m[4]) < 1) return `The ${name} step must be at least 1.`;
    }
  }
  return '';
}

export function minutesError(value: string): string {
  if (!/^\d+$/.test(value.trim())) return 'Enter whole minutes.';
  const n = Number(value);
  return n < 1 || n > 120 ? 'Training time must be 1–120 minutes.' : '';
}

export const STALE_MICROS = 30_000_000n;

// A node that hasn't sent a heartbeat for 30 s shows as down, whatever its last status said.
export function nodeHealth(status: string, lastSeenMicros: bigint, nowMicros: bigint): string {
  return nowMicros - lastSeenMicros > STALE_MICROS ? 'down' : status;
}

export function agoLabel(lastSeenMicros: bigint, nowMicros: bigint): string {
  const s = Math.max(0, Number((nowMicros - lastSeenMicros) / 1_000_000n));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
