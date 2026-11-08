import { describe, expect, it } from 'vitest';
import type { Channel, Member } from '../module_bindings/types';
import { canClear, clearQuestion } from './model';

const ch = (kind: string) => ({ id: 5n, name: 'x', kind, parentId: 0n }) as unknown as Channel;
const inDm = [{ id: 1n, channelId: 5n, memberKind: 'user', memberId: 'me' }] as Member[];

describe('clear channel', () => {
  it('is for admins; a DM only when they are in it (same rule as the module)', () => {
    expect(canClear(ch('public'), [], 'me', true)).toBe(true);
    expect(canClear(ch('thread'), [], 'me', true)).toBe(true);
    expect(canClear(ch('public'), [], 'me', false)).toBe(false);
    expect(canClear(ch('dm'), [], 'me', true)).toBe(false);
    expect(canClear(ch('dm'), inDm, 'me', true)).toBe(true);
  });
  it('names the channel, says threads go too, and that it cannot be undone', () => {
    expect(clearQuestion(ch('public'), '# general')).toMatch(/^Clear # general\?[\s\S]*in its threads[\s\S]*can't be undone/);
    expect(clearQuestion(ch('thread'), '# general › side')).not.toMatch(/threads/);
  });
});
