import { describe, expect, it } from 'vitest';
import { usableSkills } from './skills';

const row = (name: string, over: object = {}) => ({ key: `${name}@1`, name, version: 1, description: '', status: 'adopted', base: 'nano', nodeId: 1n, ...over });

describe('usableSkills', () => {
  it('offers only adopted LoRAs on the home base whose files are on the home node', () => {
    const adapters = [
      row('here'),
      row('copied', { nodeId: 2n }),
      row('elsewhere', { nodeId: 2n }),
      row('candidate', { status: 'candidate' }),
      row('otherbase', { base: 'big' }),
    ];
    const copies = [{ key: 'copied@1', nodeId: 1n }];
    expect(usableSkills(adapters, copies, { id: 1n, baseModel: 'nano' }).map(s => s.name)).toEqual(['copied', 'here']);
    expect(usableSkills(adapters, copies, undefined)).toEqual([]);
  });
});
