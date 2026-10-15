import { HALF_X } from './constants';
import { newBall, type Ball, type Side } from './types';

/**
 * Hysteresis: hand off only when the whole ball is past the halfway line and
 * moving away, so a ball bouncing on the line does not flip owners. Height is
 * ignored, so a ball above the screen still hands off.
 */
export function shouldHandOff(b: Ball, side: Side, r: number): boolean {
  return side === 'A' ? b.x > HALF_X + r && b.vx > 0 : b.x < HALF_X - r && b.vx < 0;
}

/**
 * The receiver starts the ball just off its inner edge and lets it slide in,
 * rather than fast-forwarding it by the network delay.
 */
export function entryBall(
  side: Side,
  m: { y: number; vx: number; vy: number; ball?: number; by?: Side | null; fire?: boolean; ghost?: boolean },
  r: number,
): Ball {
  const b = newBall(side === 'A' ? HALF_X + r : HALF_X - r, m.y, m.vx, m.vy);
  b.id = m.ball ?? 0;
  b.by = m.by ?? null;
  b.fire = !!m.fire;
  b.ghost = !!m.ghost;
  return b;
}

/** Drop near the halfway line on the given side. */
export function kickoffBall(side: Side, id = 0): Ball {
  // A second ball drops a little further back so the two do not land on each other.
  const back = 8 + id * 6;
  const b = newBall(side === 'A' ? HALF_X - back : HALF_X + back, 12 + id * 4);
  b.id = id;
  return b;
}
