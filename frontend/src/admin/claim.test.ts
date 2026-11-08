import { describe, expect, it } from 'vitest';
import { adminLinkFor, newAdminCode, readClaim, withoutClaim } from './claim';

describe('admin claim links', () => {
  it('reads ?claim= and strips it, keeping other params and the hash', () => {
    expect(readClaim('?claim=abc_DEF-0123456789xy')).toBe('abc_DEF-0123456789xy');
    expect(readClaim('?x=1')).toBeUndefined();
    expect(readClaim('?claim=')).toBeUndefined();
    expect(withoutClaim('http://h:8080/?claim=abc&x=1#/agents')).toBe('/?x=1#/agents');
    expect(withoutClaim('http://h:8080/?claim=abc')).toBe('/');
  });

  it('makes codes add_admin_code accepts, and a link the console reads back', () => {
    const codes = new Set(Array.from({ length: 50 }, newAdminCode));
    expect(codes.size).toBe(50);
    for (const c of codes) expect(c).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    const link = adminLinkFor('abc_DEF-0123456789xy', 'http://h:8080/?x=1#/config');
    expect(link).toBe('http://h:8080/?claim=abc_DEF-0123456789xy');
    expect(readClaim(new URL(link).search)).toBe('abc_DEF-0123456789xy');
  });
});
