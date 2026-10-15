// All distances are metres, speeds m/s. y is up, the ground is y = 0.

export const WORLD_W = 100;
export const HALF_X = 50;

/** Each screen shows one 50 m half, 28 m tall (16:9), with 3 m of grass below the ground line. */
export const VIEW_W = 50;
export const VIEW_H = 28;
export const GROUND_MARGIN = 3;
export const VIEW_TOP = VIEW_H - GROUND_MARGIN;

/** Solid stadium roof: the ball bounces off it, and the foot cannot go above it. */
export const ROOF_Y = 24;

/** Goal seen side-on at the outer edge: the net is GOAL_DEPTH deep, the crossbar GOAL_H high. */
export const GOAL_DEPTH = 3;
export const GOAL_H = 8;

/** Practice mode: face of the wall that stands in for the halfway line. */
export const WALL_X = 49.5;

export const STEP_HZ = 120;
export const DT = 1 / STEP_HZ;

export const SERVER_PORT = 8787;
export const RESEND_MS = 500;

/** Values to tune in playtests. The debug panel edits this object live. */
export const tuning = {
  gravity: 15,
  ballRadius: 0.6,
  footRadius: 1.0,
  groundBounce: 0.6,
  wallBounce: 0.7,
  netBounce: 0.15,
  maxShot: 35,
  rollFriction: 3,
  airDrag: 0.08,
  /** Ground impacts slower than this stop the ball instead of bouncing it. */
  restSpeed: 1.2,
  /** Foot bounciness for a slow push ... */
  kickSoft: 0.15,
  /** ... rising to this for a full swipe. */
  kickHard: 0.6,
  kickSoftSpeed: 3,
  kickHardSpeed: 20,
  /** Window over which foot speed is averaged. */
  smoothMs: 50,
  sensitivity: 1,
};

export type Tuning = typeof tuning;
