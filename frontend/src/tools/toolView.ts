// Read-side helpers for `tool` rows (CONTRACT.md §3) and `tool_card` messages (§6).

export type DryRun = { exitCode?: number; output: string; ms?: number };

// The runtime stores {"exit_code", "output", "ms"}; anything else is shown raw.
export function parseDryRun(text: string): DryRun {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return {
        exitCode: typeof v.exit_code === 'number' ? v.exit_code : undefined,
        output: typeof v.output === 'string' ? v.output : JSON.stringify(v, null, 2),
        ms: typeof v.ms === 'number' ? v.ms : undefined,
      };
    }
  } catch {
    // fall through
  }
  return { output: text };
}

// tool_card meta is {"key": "name@version"}.
export function toolKeyOf(meta: string): string | undefined {
  try {
    const v = JSON.parse(meta) as { key?: unknown };
    return typeof v.key === 'string' ? v.key : undefined;
  } catch {
    return undefined;
  }
}

export const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';
