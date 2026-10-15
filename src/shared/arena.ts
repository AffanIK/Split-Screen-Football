// Objects on the pitch. Positions are in side A's frame (its goal at x = 0,
// the halfway line at x = 50); side B gets the mirror image, so both halves
// are identical and the match stays fair.

import { ROOF_Y } from './constants';

export type ArenaKind =
  | 'none'
  | 'pinball'
  | 'springs'
  | 'portals'
  | 'windmill'
  | 'crusher'
  | 'pillars'
  | 'lowroof';

export interface Bumper {
  x: number;
  y: number;
  r: number;
}

/** A bumper that slides up and down. */
export interface Mover extends Bumper {
  /** How far it travels either side of y. */
  amp: number;
  /** Seconds for one full trip. */
  period: number;
  /** Where in the trip it starts, in turns (0..1). */
  phase: number;
}

/** A bar turning about its middle. */
export interface Spinner {
  x: number;
  y: number;
  len: number;
  /** Radians per second. */
  speed: number;
  /** Half its thickness. */
  thick: number;
}

/** A solid rectangle. */
export interface Block {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Colours that give each arena its own look. */
export interface Palette {
  /** Five bands of sky, top to bottom. */
  sky: string[];
  stand: string;
  led: string;
}

export interface Arena {
  name: string;
  /** One line shown with the name at kickoff. */
  text: string;
  /** Round posts that kick the ball away a little faster than it arrived. */
  bumpers: Bumper[];
  movers: Mover[];
  /** Trampoline strips on the ground, as [from x, to x]. */
  pads: [number, number][];
  /** A pair of rings: a ball entering one leaves the other. */
  portals: [Bumper, Bumper] | null;
  spinner: Spinner | null;
  blocks: Block[];
  /** Height of the ceiling. */
  roof: number;
  palette: Palette;
}

const NIGHT: Palette = {
  sky: ['#070a1c', '#0a0e26', '#0d1230', '#11173b', '#151c46'],
  stand: '#0d1128',
  led: '#ffb020',
};

const base = { bumpers: [], movers: [], pads: [], portals: null, spinner: null, blocks: [], roof: ROOF_Y, palette: NIGHT };

export const ARENAS: Record<ArenaKind, Arena> = {
  none: { ...base, name: 'STADIUM', text: 'NOTHING BUT THE PITCH' },
  pinball: {
    ...base,
    name: 'PINBALL PARK',
    text: 'BUMPERS KICK THE BALL AWAY',
    bumpers: [
      { x: 27, y: 15, r: 1.3 },
      { x: 36, y: 6, r: 1.3 },
    ],
    palette: { sky: ['#12061f', '#1a0a2e', '#230f3d', '#2c134b', '#36185a'], stand: '#160a26', led: '#ff5fd2' },
  },
  springs: {
    ...base,
    name: 'SPRING GARDEN',
    text: 'THE TRAMPOLINE THROWS IT UP',
    bumpers: [{ x: 33, y: 15, r: 1.3 }],
    pads: [[20, 26]],
    palette: { sky: ['#04161a', '#062026', '#082b32', '#0b363e', '#0e424b'], stand: '#07181c', led: '#5fe0a0' },
  },
  portals: {
    ...base,
    name: 'PORTAL LAB',
    text: 'IN ONE RING, OUT THE OTHER',
    portals: [
      { x: 44, y: 4.5, r: 1.9 },
      { x: 15, y: 17, r: 1.9 },
    ],
    palette: { sky: ['#0b0620', '#120a30', '#190e40', '#201250', '#281660'], stand: '#0f0a26', led: '#c77dff' },
  },
  windmill: {
    ...base,
    name: 'WINDMILL',
    text: 'TIME YOUR SHOT PAST THE BAR',
    spinner: { x: 30, y: 12, len: 11, speed: 1.5, thick: 0.45 },
    palette: { sky: ['#1a0d12', '#27131a', '#341a22', '#42222a', '#502a32'], stand: '#1c1014', led: '#ffb347' },
  },
  crusher: {
    ...base,
    name: 'CRUSHER',
    text: 'THE BUMPERS NEVER STOP',
    movers: [
      { x: 24, y: 12, r: 1.4, amp: 7, period: 4, phase: 0 },
      { x: 36, y: 12, r: 1.4, amp: 7, period: 4, phase: 0.5 },
    ],
    palette: { sky: ['#160606', '#210a0a', '#2c0e0e', '#381212', '#441616'], stand: '#180a0a', led: '#ff5c5c' },
  },
  pillars: {
    ...base,
    name: 'THE PILLARS',
    text: 'GO OVER OR GO BETWEEN',
    blocks: [
      { x0: 20, y0: 0, x1: 22, y1: 6 },
      { x0: 30, y0: 0, x1: 32, y1: 9 },
    ],
    palette: { sky: ['#17120a', '#221a0e', '#2d2312', '#392c16', '#45351a'], stand: '#19140c', led: '#ffd23f' },
  },
  lowroof: {
    ...base,
    name: 'LOW ROOF',
    text: 'KEEP IT FAST AND FLAT',
    roof: 13,
    blocks: [
      { x0: 16, y0: 10, x1: 18, y1: 13 },
      { x0: 27, y0: 9, x1: 29, y1: 13 },
    ],
    palette: { sky: ['#0b0f14', '#10161d', '#151d26', '#1a242f', '#1f2b38'], stand: '#0e1319', led: '#8fd3ff' },
  },
};

/** The arenas a game can be given when the choice is Random. */
export const ARCADE_ARENAS = (Object.keys(ARENAS) as ArenaKind[]).filter((k) => k !== 'none');

/** Where a sliding bumper is after `time` seconds of play. */
export function moverY(m: Mover, time: number): number {
  return m.y + m.amp * Math.sin((time / m.period + m.phase) * Math.PI * 2);
}

/** Is this spot clear of everything solid in the arena, with some room to spare? */
export function spotIsFree(arena: Arena, x: number, y: number): boolean {
  if (y > arena.roof - 2.5) return false;
  for (const b of [...arena.bumpers, ...(arena.portals ?? [])]) if (Math.hypot(b.x - x, b.y - y) < b.r + 3) return false;
  for (const m of arena.movers) if (Math.abs(m.x - x) < m.r + 3) return false;
  const s = arena.spinner;
  if (s && Math.hypot(s.x - x, s.y - y) < s.len / 2 + 2) return false;
  for (const k of arena.blocks) if (x > k.x0 - 2.5 && x < k.x1 + 2.5 && y > k.y0 - 2.5 && y < k.y1 + 2.5) return false;
  return true;
}

/** Speed a bumper or trampoline gives a ball that reaches it slowly. */
export const BUMPER_MIN_SPEED = 15;
export const BUMPER_GAIN = 1.12;
export const PAD_MIN_SPEED = 17;
export const PAD_GAIN = 1.15;
/** How much speed a ball keeps off the windmill bar or a block. */
export const SOLID_BOUNCE = 0.8;
