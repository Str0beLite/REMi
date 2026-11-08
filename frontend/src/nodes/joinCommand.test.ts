import { describe, expect, it } from 'vitest';
import { joinCommand, newJoinCode, workspaceUrl } from './joinCommand';

describe('workspaceUrl', () => {
  it('uses the address the console was opened with, else (on localhost) the stored workspace_url, else nothing', () => {
    expect(workspaceUrl('http://192.168.1.20:3000', 'ws://gpu-box:3000')).toBe('http://gpu-box:3000');
    expect(workspaceUrl('', 'ws://192.168.1.20:3000')).toBe('http://192.168.1.20:3000');
    expect(workspaceUrl('http://192.168.1.20:3000/', 'ws://localhost:3000')).toBe('http://192.168.1.20:3000');
    expect(workspaceUrl('', 'ws://localhost:3000')).toBe('');
    expect(workspaceUrl('', 'ws://127.0.0.1:3000')).toBe('');
  });
});

describe('joinCommand / newJoinCode', () => {
  it('builds one command and codes the module accepts', () => {
    expect(joinCommand('http://10.0.0.5:3000', 'remi', 'abc')).toBe(
      'git clone https://github.com/Str0beLite/REMi && cd REMi && scripts/remi join http://10.0.0.5:3000/remi abc',
    );
    const a = newJoinCode();
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(newJoinCode()).not.toBe(a);
  });
});
