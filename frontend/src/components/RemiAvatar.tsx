// Head-only REMi mascot with headgear and a status face (shapes from docs/design/remi-character-studio.html).
// Decorative: callers must show the status as text next to it (status is never shown by the face alone).

import { TINTS, type AgentStatus, type Headgear } from './remiLook';

const FUR = 'var(--ramp-300, #d3c8e6)';
const LINE = 'var(--ramp-700, #55445e)';
const PINK = 'var(--pink, #e8b8bf)';
const PAPER = '#faf7f1';
const SW = 8;
const L = 68.5;
const R = 131.5;

function Eyes({ status }: { status: AgentStatus }) {
  if (status === 'asleep')
    return (
      <path
        d={`M${L - 14.9} 94 Q${L} 109.8 ${L + 14.9} 94 M${R - 14.9} 94 Q${R} 109.8 ${R + 14.9} 94`}
        fill="none"
        stroke={LINE}
        strokeWidth={SW + 0.5}
        strokeLinecap="round"
      />
    );
  if (status === 'stopped')
    return (
      <path
        d={`M${L - 12.3} 96 H${L + 12.3} M${R - 12.3} 96 H${R + 12.3}`}
        stroke={LINE}
        strokeWidth={SW + 0.5}
        strokeLinecap="round"
      />
    );
  const [dx, dy] = status === 'thinking' ? [-2, -3] : [0, 0];
  return (
    <g fill={LINE}>
      <ellipse cx={L + dx} cy={95 + dy} rx={9.6} ry={15.7} />
      <ellipse cx={R + dx} cy={95 + dy} rx={9.6} ry={15.7} />
    </g>
  );
}

function Gear({ kind, tint }: { kind: Headgear; tint: string }) {
  const s = { stroke: LINE, strokeWidth: SW } as const;
  switch (kind) {
    case 'nightcap':
      return (
        <g>
          <path d="M56 64 C 56 24, 140 18, 148 60 Q 102 46 56 64 Z" fill={tint} {...s} />
          <path d="M118 28 C 150 14, 178 26, 184 54" fill="none" stroke={LINE} strokeWidth={SW * 2 + 12} strokeLinecap="round" />
          <path d="M118 28 C 150 14, 178 26, 184 54" fill="none" stroke={tint} strokeWidth={12} strokeLinecap="round" />
          <circle cx={185} cy={58} r={10} fill={PAPER} {...s} />
        </g>
      );
    case 'headset':
      return (
        <g>
          <path d="M38 96 C 36 24, 164 24, 162 96" fill="none" stroke={LINE} strokeWidth={SW * 2 + 5} />
          <path d="M38 96 C 36 24, 164 24, 162 96" fill="none" stroke={tint} strokeWidth={5} />
          <rect x={24} y={84} width={18} height={32} rx={8} fill={tint} {...s} />
          <rect x={158} y={84} width={18} height={32} rx={8} fill={tint} {...s} />
          <path d="M32 114 Q 38 138 74 136" fill="none" stroke={LINE} strokeWidth={SW + 1} />
          <circle cx={77} cy={136} r={5.5} fill={LINE} />
        </g>
      );
    case 'hardhat':
      return (
        <g>
          <path d="M60 64 C 62 16, 138 16, 140 64 Z" fill={tint} {...s} />
          <rect x={48} y={58} width={104} height={11} rx={5.5} fill={tint} {...s} />
          <path d="M100 24 V58" {...s} />
        </g>
      );
    case 'bow':
      return (
        <g transform="translate(152 62) rotate(18)">
          <path d="M0 0 L-17 -11 L-17 11 Z M0 0 L17 -11 L17 11 Z" fill={tint} strokeLinejoin="round" {...s} />
          <circle r={5} fill={tint} {...s} />
        </g>
      );
    default:
      return null;
  }
}

function Ear({ cx, rot }: { cx: number; rot: number }) {
  return (
    <g transform={`rotate(${rot} ${cx} 41)`}>
      <ellipse cx={cx} cy={41} rx={32.5} ry={34} fill={FUR} stroke={LINE} strokeWidth={SW} />
      <ellipse cx={cx} cy={44} rx={20} ry={21.5} fill={PINK} />
    </g>
  );
}

type Props = { status: AgentStatus; headgear?: Headgear; tint?: string; size?: number; className?: string };

export function RemiAvatar({ status, headgear = 'none', tint = TINTS[0], size = 32, className }: Props) {
  const stopped = status === 'stopped';
  return (
    <svg
      viewBox="2 -6 196 176"
      width={size}
      height={Math.round((size * 176) / 196)}
      aria-hidden="true"
      focusable="false"
      className={className}
      data-status={status}
      data-headgear={headgear}
      style={stopped ? { filter: 'saturate(0.12)', opacity: 0.75, flex: 'none' } : { flex: 'none' }}
    >
      <Ear cx={45.5} rot={-15} />
      <Ear cx={154.5} rot={15} />
      <rect x={29} y={43} width={142} height={119} rx={64} ry={54} fill={FUR} stroke={LINE} strokeWidth={SW} />
      <ellipse cx={52} cy={118} rx={11} ry={6} fill={PINK} opacity={0.6} />
      <ellipse cx={148} cy={118} rx={11} ry={6} fill={PINK} opacity={0.6} />
      <ellipse cx={100} cy={112} rx={9} ry={6.5} fill={LINE} />
      <Eyes status={status} />
      <Gear kind={headgear} tint={tint} />
    </svg>
  );
}
