import { describe, expect, it } from 'vitest';
import { agoLabel, cronError, cronLabel, minutesError, nodeHealth } from './configData';

describe('cronError', () => {
  it.each(['0 3 * * *', '*/15 * * * *', '0 2-4 * * 1-5', '30 1,13 1 */2 0', '0 3 * * 7'])('accepts %s', e => {
    expect(cronError(e)).toBe('');
  });
  it.each([
    ['0 3 * *', /5 fields/],
    ['60 3 * * *', /minute field must be between 0 and 59/],
    ['0 24 * * *', /hour/],
    ['0 3 0 * *', /day of month/],
    ['0 3 * 13 *', /month/],
    ['0 5-2 * * *', /backwards/],
    ['0 3 * * mon', /isn't valid cron/],
    ['*/0 * * * *', /step/],
  ])('rejects %s', (e, msg) => {
    expect(cronError(e)).toMatch(msg);
  });
});

describe('minutesError', () => {
  it('allows whole minutes 1–120', () => {
    expect(minutesError('30')).toBe('');
    expect(minutesError('120')).toBe('');
    expect(minutesError('0')).toMatch(/1–120/);
    expect(minutesError('121')).toMatch(/1–120/);
    expect(minutesError('2.5')).toMatch(/whole/);
  });
});

describe('nodeHealth', () => {
  const now = 100_000_000n;
  it('marks a node down after 30 s without a heartbeat', () => {
    expect(nodeHealth('up', now - 29_000_000n, now)).toBe('up');
    expect(nodeHealth('asleep', now - 10_000_000n, now)).toBe('asleep');
    expect(nodeHealth('up', now - 31_000_000n, now)).toBe('down');
  });
  it('labels how long ago', () => {
    expect(agoLabel(now - 5_000_000n, now)).toBe('5s ago');
    expect(agoLabel(now - 90_000_000n, now)).toBe('1m ago');
  });
});

describe('cronLabel', () => {
  it('reads the common nightly shapes and gives up on fancier ones', () => {
    expect(cronLabel('0 3 * * *')).toBe('03:00 every night');
    expect(cronLabel('30 22 * * 1-5')).toBe('22:30 on weekdays');
    expect(cronLabel('0 4 * * 0')).toBe('04:00 every Sunday');
    expect(cronLabel('*/15 * * * *')).toBe('');
    expect(cronLabel('nope')).toBe('');
  });
});
