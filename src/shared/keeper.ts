import type { KeeperLevel } from './config';
import { GOAL_DEPTH, WORLD_W, type Tuning } from './constants';
import type { Ball, Side } from './types';

/** The keeper slides on a rail this far out from its own goal line (side A's frame). */
export const KEEPER_X = GOAL_DEPTH + 2.5;
export const KEEPER_R = 1.3;

/** Top speed in m/s, and seconds between looks at the ball: a slow look is a late dive. */
const LEVELS: Record<Exclude<KeeperLevel, 'off'>, { speed: number; react: number }> = {
  easy: { speed: 7, react: 0.38 },
  normal: { speed: 11, react: 0.24 },
  hard: { speed: 16, react: 0.12 },
};

/** How far ahead the keeper bothers to look. */
const LOOK_AHEAD_S = 1.6;

export interface Keeper {
  y: number;
  /** Where it was before the last step, so contact is checked along its path. */
  prevY: number;
  vy: number;
  target: number;
  /** Seconds until it next looks at the ball. */
  think: number;
  /** Seconds it is still stunned for. */
  stun: number;
}

export function newKeeper(): Keeper {
  return { y: 3, prevY: 3, vy: 0, target: 3, think: 0, stun: 0 };
}

/**
 * One step of the goalkeeper bot. It works out where the most dangerous ball
 * will cross its rail and slides there, no faster than its level allows.
 */
export function stepKeeper(
  k: Keeper,
  balls: readonly Ball[],
  side: Side,
  level: Exclude<KeeperLevel, 'off'>,
  goalH: number,
  t: Tuning,
  dt: number,
): void {
  const { speed, react } = LEVELS[level];
  k.prevY = k.y;
  if (k.stun > 0) {
    k.stun -= dt;
    k.vy = 0;
    return;
  }

  k.think -= dt;
  if (k.think <= 0) {
    k.think = react;
    // Rest position: a little below the middle of the goal.
    let target = goalH * 0.4;
    let soonest = LOOK_AHEAD_S;
    for (const b of balls) {
      const x = side === 'A' ? b.x : WORLD_W - b.x;
      const vx = side === 'A' ? b.vx : -b.vx;
      if (vx > -2 || x < KEEPER_X) continue;
      const time = (x - KEEPER_X) / -vx;
      if (time >= soonest) continue;
      soonest = time;
      // Where gravity will have taken it by then; a ball that would be underground is rolling.
      target = Math.abs(b.y + b.vy * time - 0.5 * t.gravity * time * time);
    }
    k.target = Math.min(goalH - KEEPER_R * 0.6, Math.max(KEEPER_R, target));
  }

  const gap = k.target - k.y;
  const step = Math.min(Math.abs(gap), speed * dt);
  k.y += Math.sign(gap) * step;
  k.vy = (k.y - k.prevY) / dt;
}
