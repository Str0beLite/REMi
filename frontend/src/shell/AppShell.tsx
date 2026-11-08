import { useEffect, useState, type ReactNode } from 'react';
import './shell.css';

type Props = { rail: ReactNode; main: ReactNode; swarm: ReactNode; title?: string };

// Rack elevation frame: plum channel rail | chat | Swarm rail.
// Below 900px the Swarm rail opens from a toggle; below 640px the channel rail becomes a drawer.
export function AppShell({ rail, main, swarm, title = 'REMi' }: Props) {
  const [railOpen, setRailOpen] = useState(false);
  const [swarmOpen, setSwarmOpen] = useState(false);
  const anyOpen = railOpen || swarmOpen;

  useEffect(() => {
    if (!anyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setRailOpen(false);
        setSwarmOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anyOpen]);

  return (
    <div className="shell" data-rail-open={railOpen} data-swarm-open={swarmOpen}>
      {/* not a #hash link: the hash is the app's route */}
      <a
        href="#composer"
        className="skip-link"
        onClick={e => {
          e.preventDefault();
          (document.getElementById('composer') ?? document.getElementById('shell-main'))?.focus();
        }}
      >
        Skip to message box
      </a>
      <div className="shell-bar">
        <button
          type="button"
          className="shell-toggle shell-toggle-rail"
          aria-expanded={railOpen}
          aria-controls="shell-rail"
          onClick={() => {
            setRailOpen(o => !o);
            setSwarmOpen(false);
          }}
        >
          Menu
        </button>
        <span className="shell-bar-title">{title}</span>
        <button
          type="button"
          className="shell-toggle shell-toggle-swarm"
          aria-expanded={swarmOpen}
          aria-controls="shell-swarm"
          onClick={() => {
            setSwarmOpen(o => !o);
            setRailOpen(false);
          }}
        >
          Swarm
        </button>
      </div>
      {/* picking a rail item navigates, so close the drawer; the + buttons and forms keep it open */}
      <nav
        id="shell-rail"
        className="shell-rail"
        aria-label="Channels"
        onClick={e => (e.target as Element).closest('.rail-item, .rail-me') && setRailOpen(false)}
      >
        {rail}
      </nav>
      <main id="shell-main" className="shell-main" tabIndex={-1}>
        {main}
      </main>
      {/* a button in the Swarm drawer navigates, so close the drawer to show where it went */}
      <aside
        id="shell-swarm"
        className="shell-swarm"
        aria-label="Swarm"
        onClick={e => (e.target as Element).closest('button') && setSwarmOpen(false)}
      >
        {swarm}
      </aside>
      {anyOpen && (
        <button
          type="button"
          className="shell-scrim"
          aria-label="Close panel"
          onClick={() => {
            setRailOpen(false);
            setSwarmOpen(false);
          }}
        />
      )}
    </div>
  );
}
