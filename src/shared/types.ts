import type { Arena } from './arena';

export type Side = 'A' | 'B';

export const other = (s: Side): Side => (s === 'A' ? 'B' : 'A');

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Position before the last physics step, for render interpolation. */
  px: number;
  py: number;
  /** Visual rotation only; spin does not affect flight yet. */
  angle: number;
  spin: number;
  onGround: boolean;
  /** Which ball this is; a match can have two. */
  id: number;
  /** Who kicked it last. Power-ups go to them. */
  by: Side | null;
  /** A super shot: flies above the cap and stuns the boot that blocks it. */
  fire: boolean;
  /** Hidden from the receiving player until it is close to their goal. */
  ghost: boolean;
  /** Seconds before it can go through a portal again. */
  warp: number;
}

export function newBall(x: number, y: number, vx = 0, vy = 0): Ball {
  return {
    x,
    y,
    vx,
    vy,
    px: x,
    py: y,
    angle: 0,
    spin: 0,
    onGround: false,
    id: 0,
    by: null,
    fire: false,
    ghost: false,
    warp: 0,
  };
}

/** What the ball is simulated in: which half, and everything Arcade mode adds to it. */
export interface World {
  side: Side;
  /** Practice wall closing the halfway line. */
  wall: boolean;
  /** Crossbar height; the normal goal when left out. */
  goalH?: number;
  /** Sideways push on a ball in the air, m/s², in world direction. */
  wind?: number;
  arena?: Arena | null;
  portalsOpen?: boolean;
  /** Seconds of play so far; moving arena objects are placed by it. */
  time?: number;
  /** The goalkeeper's path during this step, in side A's frame. Left out when there is none. */
  keeper?: { x: number; y0: number; y1: number; vy: number; r: number };
  /** Hazards, in side A's frame: points that pull the ball in, and muddy strips of ground. */
  wells?: { x: number; y: number }[];
  mud?: [number, number][];
}

export type BounceKind = 'ground' | 'post' | 'wall' | 'board' | 'net' | 'roof';

/** Positions and velocities in events are world coordinates. */
export type SimEvent =
  | { type: 'bounce'; kind: BounceKind; speed: number; x: number; y: number }
  /**
   * power = closing speed between foot and ball; before/speed = ball speed
   * either side of the touch; x, y, vx, vy = the ball as it leaves the foot.
   */
  | { type: 'kick'; power: number; before: number; speed: number; air: boolean; x: number; y: number; vx: number; vy: number }
  | { type: 'goal' }
  | { type: 'bumper'; x: number; y: number }
  | { type: 'pad'; x: number; y: number }
  | { type: 'portal'; x: number; y: number }
  /** The goalkeeper got to it. `fire` if it was a fireball, which stuns the keeper. */
  | { type: 'keeper'; x: number; y: number; fire: boolean }
  /** A charged foot has just launched a fireball. */
  | { type: 'fire' }
  /** The foot was stunned by what it blocked. */
  | { type: 'stun'; ms: number; foot?: number };
