import { describe, expect, it } from 'vitest';
import { firstLine, parseDryRun, toolKeyOf } from './toolView';

describe('parseDryRun', () => {
  it('reads the runtime shape', () => {
    expect(parseDryRun('{"exit_code":0,"output":"612 W","ms":120}')).toEqual({ exitCode: 0, output: '612 W', ms: 120 });
  });
  it('shows other JSON and non-JSON as-is', () => {
    expect(parseDryRun('{"out":"x"}').output).toContain('"out": "x"');
    expect(parseDryRun('not json')).toEqual({ output: 'not json' });
  });
});

describe('toolKeyOf', () => {
  it('reads the key from tool_card meta, or nothing', () => {
    expect(toolKeyOf('{"key":"host_power@1"}')).toBe('host_power@1');
    expect(toolKeyOf('{}')).toBeUndefined();
    expect(toolKeyOf('nope')).toBeUndefined();
  });
});

it('firstLine trims and takes the first line', () => {
  expect(firstLine('\n  Reads power.\nMore.')).toBe('Reads power.');
});
