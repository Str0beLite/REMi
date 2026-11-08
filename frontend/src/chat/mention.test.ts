import { describe, expect, it } from 'vitest';
import type { Agent, User } from '../module_bindings/types';
import { mentionMatches, mentionQuery } from './model';

const agent = (name: string) => ({ name }) as Agent;
const user = (nickname: string, hex: string) => ({ nickname, identity: { toHexString: () => hex } }) as unknown as User;

describe('mentionQuery', () => {
  it('finds the @word before the caret', () => {
    expect(mentionQuery('hi @sle', 7)).toEqual({ start: 3, query: 'sle' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('ping @ops-bot', 13)).toEqual({ start: 5, query: 'ops-bot' });
  });
  it('ignores emails, finished words and text after the caret', () => {
    expect(mentionQuery('me@host', 7)).toBeNull();
    expect(mentionQuery('@sleep done', 11)).toBeNull();
    expect(mentionQuery('a-@x', 4)).toBeNull();
  });
});

describe('mentionMatches', () => {
  const agents = [agent('ops'), agent('sleep-remi'), agent('dev-ops')];
  const users = [user('Priya', 'p'), user('me', 'self'), user('Two Words', 't')];
  it('puts prefix matches first, REMis before people, and skips me and spaced names', () => {
    expect(mentionMatches('op', agents, users, 'self').map(o => o.name)).toEqual(['ops', 'dev-ops']);
    expect(mentionMatches('', agents, users, 'self').map(o => o.name)).toEqual(['ops', 'sleep-remi', 'dev-ops', 'Priya']);
    expect(mentionMatches('PRI', agents, users, 'self').map(o => o.kind)).toEqual(['user']);
  });
});
