import { describe, expect, it } from 'vitest';
import { clusterConsoleUrl, joinLink, readJoin } from './joinCommand';

const page = (origin: string) => ({ origin, hostname: new URL(origin).hostname });

describe('clusterConsoleUrl', () => {
  it('uses the address the console was opened with, else (on localhost) workspace_url on the console port, else nothing', () => {
    expect(clusterConsoleUrl('http://192.168.1.20:3000', page('http://gpu-box:8080'))).toBe('http://gpu-box:8080');
    expect(clusterConsoleUrl('http://192.168.1.20:3000/', page('http://localhost:8080'))).toBe('http://192.168.1.20:8080');
    expect(clusterConsoleUrl('', page('http://127.0.0.1:5173'))).toBe('');
  });
});

describe('joinLink / readJoin', () => {
  it('round-trips the code', () => {
    const link = joinLink('http://10.0.0.5:8080', 'remi', 'abc_DEF-0123456789xyz');
    expect(link).toBe('http://10.0.0.5:8080/?join=abc_DEF-0123456789xyz&db=remi');
    expect(readJoin(new URL(link).search)).toBe('abc_DEF-0123456789xyz');
    expect(readJoin('?claim=x')).toBeUndefined();
  });
});
