import { beforeEach, describe, expect, it, vi } from 'vitest';

// stdb.ts reads `location` when it loads (the console's own host), and tests run without a browser
vi.hoisted(() => {
  (globalThis as { location?: unknown }).location ??= { protocol: 'http:', hostname: 'localhost' };
});

const { loadLastSeen, saveLastSeen } = await import('./lastSeen');

describe('lastSeen', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  });

  it('survives a reload: bigint ids round-trip through storage', () => {
    saveLastSeen({ '1': 42n, '7': 9007199254740993n });
    expect(loadLastSeen()).toEqual({ '1': 42n, '7': 9007199254740993n });
  });

  it('starts empty on bad or blocked storage', () => {
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => '{not json', setItem: () => {} };
    expect(loadLastSeen()).toEqual({});
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    expect(loadLastSeen()).toEqual({});
    expect(() => saveLastSeen({ '1': 1n })).not.toThrow();
  });
});
