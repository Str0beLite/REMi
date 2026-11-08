import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppShell } from './AppShell';
import { ChannelRail } from './ChannelRail';
import { channelSlug } from './channelSlug';

const rail = (activeId?: bigint) =>
  renderToStaticMarkup(
    <ChannelRail
      workspace="REMi · dc-east"
      channels={[
        { id: 1n, name: 'general' },
        { id: 2n, name: 'tools-review', unread: 2 },
        { id: 3n, name: 'capacity', unread: 140 },
      ]}
      dms={[{ id: 9n, name: 'Priya Raman' }]}
      activeId={activeId}
      onSelect={() => {}}
      user={{ nickname: 'Priya Raman', isAdmin: true }}
    />,
  );

describe('AppShell', () => {
  it('renders the three slots as nav, main and aside with collapsed toggles', () => {
    const out = renderToStaticMarkup(<AppShell rail={<p>R</p>} main={<p>M</p>} swarm={<p>S</p>} />);
    expect(out).toMatch(/<nav id="shell-rail"[^>]*aria-label="Channels"><p>R<\/p><\/nav>/);
    expect(out).toContain('<main id="shell-main" class="shell-main" tabindex="-1"><p>M</p></main>');
    expect(out).toContain('class="skip-link">Skip to message box</a>');
    expect(out).toMatch(/<aside id="shell-swarm"[^>]*><p>S<\/p><\/aside>/);
    expect(out).toContain('aria-controls="shell-swarm"');
    expect(out).toContain('aria-controls="shell-rail"');
    expect(out.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(out).not.toContain('shell-scrim');
  });
});

describe('ChannelRail', () => {
  it('marks only the active channel and shows unread counts as text', () => {
    const out = rail(1n);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-current="page"[^>]*>.*# general/);
    expect(out).toContain('aria-label="2 unread">2<');
    expect(out).toContain('>99+<');
  });

  it('lists DMs and the current user with an admin label, all as buttons', () => {
    const out = rail();
    expect(out).toContain('Priya Raman');
    expect(out).toContain('<small>Admin</small>');
    expect(out.match(/<button type="button" class="rail-item"/g)).toHaveLength(4);
    expect(out).not.toContain('aria-current');
  });
});

describe('threads', () => {
  it('nests threads under their channel, marks the active thread, and offers + per channel', () => {
    const out = renderToStaticMarkup(
      <ChannelRail
        workspace="w"
        channels={[{ id: 1n, name: 'general', threads: [{ id: 5n, name: 'gpu plans', unread: 3 }] }, { id: 2n, name: 'ops' }]}
        dms={[]}
        activeId={5n}
        onSelect={() => {}}
        onCreateThread={async () => {}}
        user={{ nickname: 'A', isAdmin: false }}
      />,
    );
    expect(out.match(/class="rail-list rail-threads"/g)).toHaveLength(1);
    expect(out).toMatch(/# general.*rail-threads.*aria-current="page"[^>]*><span class="rail-label">gpu plans/);
    expect(out).toContain('aria-label="3 unread"');
    expect(out).toContain('aria-label="New thread in # general"');
    expect(out).toContain('aria-label="New thread in # ops"');
  });
});

describe('user row', () => {
  it('is a Settings button only when settings can be opened', () => {
    const base = { workspace: 'w', channels: [], dms: [], onSelect: () => {}, user: { nickname: 'A', isAdmin: false } };
    expect(renderToStaticMarkup(<ChannelRail {...base} />)).not.toContain('Settings');
    const out = renderToStaticMarkup(<ChannelRail {...base} onOpenSettings={() => {}} settingsCurrent />);
    expect(out).toMatch(/<button type="button" class="rail-me" aria-current="page"[^>]*title="Settings"/);
  });
});

describe('new channel', () => {
  it('turns what you type into a name the module accepts', () => {
    expect(channelSlug('  Capacity Planning! ')).toBe('capacity-planning');
    expect(channelSlug('ops_2')).toBe('ops-2');
    expect(channelSlug('x'.repeat(40))).toHaveLength(32);
    expect(channelSlug('!!!')).toBe('');
  });

  it('shows the + button only when creating is possible', () => {
    const base = { workspace: 'w', channels: [], dms: [], onSelect: () => {}, user: { nickname: 'A', isAdmin: false } };
    expect(renderToStaticMarkup(<ChannelRail {...base} />)).not.toContain('New channel');
    expect(renderToStaticMarkup(<ChannelRail {...base} onCreate={async () => {}} />)).toContain('aria-label="New channel"');
  });
});
