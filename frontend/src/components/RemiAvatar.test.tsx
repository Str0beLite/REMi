import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RemiAvatar } from './RemiAvatar';
import { AGENT_STATUSES, HEADGEAR, defaultLook } from './remiLook';

describe('RemiAvatar', () => {
  const cases = AGENT_STATUSES.flatMap(status => HEADGEAR.map(headgear => [status, headgear] as const));

  it.each(cases)('renders %s with %s', (status, headgear) => {
    const html = renderToStaticMarkup(<RemiAvatar status={status} headgear={headgear} tint="#3e9c8f" size={32} />);
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain(`data-headgear="${headgear}"`);
    expect(html).toContain('aria-hidden="true"');
  });

  it('greys out a stopped agent only', () => {
    expect(renderToStaticMarkup(<RemiAvatar status="stopped" />)).toContain('saturate(0.12)');
    expect(renderToStaticMarkup(<RemiAvatar status="idle" />)).not.toContain('saturate');
  });

  it('falls back to a nightcap for protected agents and a stable tint by name', () => {
    expect(defaultLook({ name: 'sleep-remi', protected: true }).headgear).toBe('nightcap');
    const a = defaultLook({ name: 'oncall', protected: false });
    expect(a).toEqual(defaultLook({ name: 'oncall', protected: false }));
    expect(a.headgear).toBe('none');
  });
});
