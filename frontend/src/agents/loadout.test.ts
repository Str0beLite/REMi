import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from './agentfile';
import { LOADOUT } from './loadout';

describe('loadout', () => {
  it('has a tile for every built-in tool and nothing else', () => {
    expect(Object.keys(LOADOUT).sort()).toEqual([...BUILTIN_TOOLS].sort());
    for (const t of BUILTIN_TOOLS) expect(LOADOUT[t].does.length).toBeGreaterThan(0);
  });
});
