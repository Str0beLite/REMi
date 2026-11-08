import { describe, expect, it } from 'vitest';
import { readRoute, writeRoute } from './route';

describe('route', () => {
  it('round-trips panel and channel', () => {
    expect(readRoute(writeRoute({ panel: 'agents', channelId: 12n }))).toEqual({ panel: 'agents', channelId: 12n });
    expect(readRoute('#/chat/3')).toEqual({ panel: 'chat', channelId: 3n });
  });
  it('falls back to chat for empty or unknown hashes', () => {
    expect(readRoute('')).toEqual({ panel: 'chat', channelId: undefined });
    expect(readRoute('#/nope/x')).toEqual({ panel: 'chat', channelId: undefined });
  });
});
