import type { Tuning } from './constants';
import { ARCADE } from './effects';
import type { Ball, Side, SimEvent } from './types';

/** The path the foot travels during one physics step, plus its smoothed velocity. */
export interface FootSweep {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  vx: number;
  vy: number;
  /** Whose foot this is, recorded on the ball as its last kicker. */
  side?: Side;
  /** Super meter full: the next hard kick launches a fireball. */
  charged?: boolean;
  /** Which boot on its side this is: 0 for the runner's, 1 for their teammate's. */
  id?: number;
}

/** A charged kick must be at least this hard to launch a fireball. */
const FIRE_KICK = 15;

/**
 * Follows the cursor foot. Input arrives once per render frame; physics runs
 * at a fixed rate, so the frame's movement is split evenly over its steps.
 */
export class FootTracker {
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  private sx: number;
  private sy: number;
  private samples: { dx: number; dy: number; dt: number }[] = [];

  constructor(x: number, y: number) {
    this.x = this.sx = x;
    this.y = this.sy = y;
  }

  /** Move without sweeping, e.g. when the pointer re-enters the window somewhere else. */
  reset(x: number, y: number): void {
    this.x = this.sx = x;
    this.y = this.sy = y;
    this.vx = this.vy = 0;
    this.samples.length = 0;
  }

  update(nx: number, ny: number, dt: number, t: Tuning): void {
    if (dt <= 0) return;
    this.samples.push({ dx: nx - this.x, dy: ny - this.y, dt });
    this.x = nx;
    this.y = ny;

    const window = t.smoothMs / 1000;
    let total = 0;
    for (const s of this.samples) total += s.dt;
    while (this.samples.length > 1 && total - this.samples[0].dt >= window) {
      total -= this.samples.shift()!.dt;
    }
    let dx = 0;
    let dy = 0;
    for (const s of this.samples) {
      dx += s.dx;
      dy += s.dy;
    }
    this.vx = dx / total;
    this.vy = dy / total;
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > t.maxShot) {
      this.vx *= t.maxShot / speed;
      this.vy *= t.maxShot / speed;
    }
  }

  /** Step i of n in the current frame. */
  sweep(i: number, n: number): FootSweep {
    const a = i / n;
    const b = (i + 1) / n;
    return {
      x0: this.sx + (this.x - this.sx) * a,
      y0: this.sy + (this.y - this.sy) * a,
      x1: this.sx + (this.x - this.sx) * b,
      y1: this.sy + (this.y - this.sy) * b,
      vx: this.vx,
      vy: this.vy,
    };
  }

  /** Call after the frame's physics steps have consumed the movement. */
  commit(): void {
    this.sx = this.x;
    this.sy = this.y;
  }
}

/**
 * Foot-vs-ball contact, checked along the whole path the foot travelled so a
 * fast swipe cannot jump over the ball. The ball takes the closing speed along
 * the line from the foot's centre to its own, so where the foot strikes matters.
 */
export function collideFoot(b: Ball, f: FootSweep, t: Tuning, ev: SimEvent[]): boolean {
  const R = t.footRadius + t.ballRadius;
  const mx = b.x - f.x0;
  const my = b.y - f.y0;
  const sx = f.x1 - f.x0;
  const sy = f.y1 - f.y0;
  const m2 = mx * mx + my * my;

  let nx: number;
  let ny: number;
  let time = 0;
  if (m2 < R * R) {
    // Already touching at the start of the step.
    const d = Math.sqrt(m2);
    if (d > 1e-6) {
      nx = mx / d;
      ny = my / d;
    } else {
      const fs = Math.hypot(f.vx, f.vy);
      nx = fs > 1e-6 ? f.vx / fs : 0;
      ny = fs > 1e-6 ? f.vy / fs : 1;
    }
  } else {
    // First moment along the path at which the two circles touch.
    const a = sx * sx + sy * sy;
    if (a < 1e-12) return false;
    const sm = sx * mx + sy * my;
    const disc = sm * sm - a * (m2 - R * R);
    if (disc < 0) return false;
    time = (sm - Math.sqrt(disc)) / a;
    if (time < 0 || time > 1) return false;
    nx = (b.x - (f.x0 + sx * time)) / R;
    ny = (b.y - (f.y0 + sy * time)) / R;
  }

  const closing = (f.vx - b.vx) * nx + (f.vy - b.vy) * ny;
  if (closing > 0) {
    const before = Math.hypot(b.vx, b.vy);
    // Blocking the opponent's fireball, or any shot near the cap, stuns the boot.
    const theirs = b.by !== null && f.side !== undefined && b.by !== f.side;
    if (theirs && b.fire) {
      b.fire = false;
      ev.push({ type: 'stun', ms: ARCADE.fireStunMs, foot: f.id });
    } else if (theirs && before >= ARCADE.stunAt * t.maxShot) {
      ev.push({ type: 'stun', ms: ARCADE.stunMs, foot: f.id });
    }

    const k = Math.min(1, Math.max(0, (closing - t.kickSoftSpeed) / (t.kickHardSpeed - t.kickSoftSpeed)));
    const e = t.kickSoft + (t.kickHard - t.kickSoft) * k;
    const air = b.y > t.ballRadius + 0.4;
    b.vx += (1 + e) * closing * nx;
    b.vy += (1 + e) * closing * ny;
    if (f.side) b.by = f.side;

    let speed = Math.hypot(b.vx, b.vy);
    let cap = t.maxShot;
    if (f.charged && closing > FIRE_KICK && speed > 0) {
      // A charged kick leaves at fireball speed whatever the swing.
      b.fire = true;
      cap *= ARCADE.fireMult;
      b.vx *= cap / speed;
      b.vy *= cap / speed;
      speed = cap;
      ev.push({ type: 'fire' });
    } else if (speed > cap) {
      b.vx *= cap / speed;
      b.vy *= cap / speed;
      speed = cap;
    }
    if (closing > 1.5) {
      ev.push({ type: 'kick', power: closing, before, speed, air, x: b.x, y: b.y, vx: b.vx, vy: b.vy });
    }
  }

  // The foot keeps moving after first contact; carry the ball with it along
  // the contact normal so it ends up ahead of the foot, never behind it.
  const carry = (1 - time) * (sx * nx + sy * ny);
  if (carry > 0) {
    b.x += nx * carry;
    b.y += ny * carry;
  }
  const qx = b.x - f.x1;
  const qy = b.y - f.y1;
  const q2 = qx * qx + qy * qy;
  if (q2 < R * R) {
    const qn = qx * nx + qy * ny;
    const push = -qn + Math.sqrt(qn * qn - (q2 - R * R));
    b.x += nx * push;
    b.y += ny * push;
  }
  return true;
}
