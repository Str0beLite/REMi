import { describe, expect, it } from 'vitest';
import type { Message } from '../module_bindings/types';
import { feedItems } from './model';

let n = 0n;
const msg = (kind: string, authorId = '1', authorKind = 'agent') => ({ id: ++n, kind, authorId, authorKind, body: kind, meta: '{}' }) as unknown as Message;

describe('feedItems', () => {
  it('folds back-to-back tool calls from one agent into one block of call/result pairs', () => {
    const items = feedItems([msg('chat'), msg('tool_call'), msg('tool_result'), msg('tool_call'), msg('tool_result'), msg('chat')]);
    expect(items.map(i => i.kind)).toEqual(['msg', 'tools', 'msg']);
    const run = items[1];
    expect(run.kind === 'tools' && run.steps.map(s => [s.call?.kind, s.result?.kind])).toEqual([
      ['tool_call', 'tool_result'],
      ['tool_call', 'tool_result'],
    ]);
  });

  it('starts a new block for another agent, and keeps an orphan result as its own step', () => {
    const items = feedItems([msg('tool_call', '1'), msg('tool_call', '2'), msg('tool_result', '2'), msg('tool_result', '2')]);
    expect(items.map(i => i.kind)).toEqual(['tools', 'tools']);
    const b = items[1];
    expect(b.kind === 'tools' && b.steps.map(s => [!!s.call, !!s.result])).toEqual([
      [true, true],
      [false, true],
    ]);
  });
});
