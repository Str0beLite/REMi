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

  it("folds one sleep's training updates into one card with the loss curve, and a new sleep gets a new card", () => {
    const ev = (phase: string, step?: number, loss?: number, spec = 'tooluse-train') =>
      ({ ...msg('sleep_event'), meta: JSON.stringify({ phase, spec, step, loss }) }) as Message;
    const items = feedItems([
      ev('asleep'), ev('training', 1, 1.6), msg('chat', '9', 'user'), ev('training', 2, 0.9), ev('training', 3, 0.2), ev('wake'),
      ev('asleep', undefined, undefined, 'sleepops-train'), ev('training', 1, 0.7, 'sleepops-train'),
    ]);
    expect(items.map(i => i.kind)).toEqual(['msg', 'training', 'msg', 'msg', 'msg', 'training']);
    const first = items[1];
    expect(first.kind === 'training' && first.points).toEqual([{ step: 1, loss: 1.6 }, { step: 2, loss: 0.9 }, { step: 3, loss: 0.2 }]);
    const second = items[5];
    expect(second.kind === 'training' && second.points).toEqual([{ step: 1, loss: 0.7 }]);
    expect([first.kind === 'training' && first.done, second.kind === 'training' && second.done]).toEqual([true, false]); // Stop only while running
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
