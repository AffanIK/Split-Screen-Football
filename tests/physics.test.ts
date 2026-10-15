import { describe, expect, it } from 'vitest';
import { DT, GOAL_H, ROOF_Y, tuning as t } from '../src/shared/constants';
import { FootTracker, collideFoot, type FootSweep } from '../src/shared/foot';
import { isGoal, stepWorld } from '../src/shared/physics';
import { newBall, type SimEvent, type World } from '../src/shared/types';

const A: World = { side: 'A', wall: true };

function run(b: ReturnType<typeof newBall>, seconds: number, world = A): SimEvent[] {
  const ev: SimEvent[] = [];
  for (let i = 0; i < seconds / DT; i++) stepWorld(b, null, DT, world, t, ev);
  return ev;
}

const still = (x: number, y: number): FootSweep => ({ x0: x, y0: y, x1: x, y1: y, vx: 0, vy: 0 });

describe('ball physics', () => {
  it('settles on the ground instead of bouncing forever', () => {
    const b = newBall(25, 10);
    run(b, 10);
    expect(b.y).toBeCloseTo(t.ballRadius, 5);
    expect(b.vy).toBe(0);
    expect(b.onGround).toBe(true);
  });

  it('keeps the set share of speed on a ground bounce', () => {
    const b = newBall(25, t.ballRadius + 0.01, 0, -10);
    stepWorld(b, null, DT, A, t, []);
    expect(b.vy / 10).toBeGreaterThan(t.groundBounce - 0.02);
    expect(b.vy / 10).toBeLessThan(t.groundBounce + 0.02);
  });

  it('rolling friction brings a rolling ball to rest', () => {
    const b = newBall(10, t.ballRadius, 6, 0);
    run(b, 5);
    expect(b.vx).toBe(0);
    expect(b.x).toBeGreaterThan(10);
  });

  it('bounces back off the practice wall and never passes it', () => {
    const b = newBall(45, 5, 30, 0);
    const ev = run(b, 1);
    expect(ev.some((e) => e.type === 'bounce' && e.kind === 'wall')).toBe(true);
    expect(b.x).toBeLessThan(50);
    expect(b.vx).toBeLessThan(0);
  });

  it('a high ball comes back off the board above the crossbar', () => {
    const b = newBall(10, GOAL_H + 6, -20, 6);
    const ev = run(b, 0.6);
    expect(ev.some((e) => e.type === 'bounce' && e.kind === 'board')).toBe(true);
    expect(b.vx).toBeGreaterThan(0);
  });

  it('a low ball goes under the crossbar and is a goal', () => {
    const b = newBall(10, 2, -20, 2);
    run(b, 1);
    expect(isGoal(b, 'A', t)).toBe(true);
  });

  it('bounces back down off the roof and never leaves the top', () => {
    const b = newBall(25, 15, 2, 30);
    const ev: SimEvent[] = [];
    for (let i = 0; i < 2 / DT; i++) {
      stepWorld(b, null, DT, A, t, ev);
      expect(b.y).toBeLessThanOrEqual(ROOF_Y - t.ballRadius + 1e-9);
    }
    expect(ev.some((e) => e.type === 'bounce' && e.kind === 'roof')).toBe(true);
  });

  it('a long fall never exceeds the shot cap', () => {
    const b = newBall(25, 20, 0, -34);
    const ev: SimEvent[] = [];
    for (let i = 0; i < 8 / DT; i++) {
      stepWorld(b, null, DT, A, t, ev);
      expect(Math.hypot(b.vx, b.vy)).toBeLessThanOrEqual(t.maxShot + 1e-9);
    }
  });

  it('side B is the mirror image of side A', () => {
    const a = newBall(20, 6, -12, 3);
    const b = newBall(80, 6, 12, 3);
    run(a, 2, { side: 'A', wall: false });
    run(b, 2, { side: 'B', wall: false });
    expect(b.x).toBeCloseTo(100 - a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
  });
});

describe('foot', () => {
  it('a fast swipe across the ball registers even though neither end touches it', () => {
    const b = newBall(25, 5);
    const ev: SimEvent[] = [];
    // The foot jumps 10 m in one step, from one side of the ball to the other.
    const hit = collideFoot(b, { x0: 20, y0: 5, x1: 30, y1: 5, vx: 30, vy: 0 }, t, ev);
    expect(hit).toBe(true);
    expect(b.vx).toBeGreaterThan(0);
    expect(b.x).toBeGreaterThan(30);
  });

  it('never sends the ball faster than the shot cap', () => {
    const b = newBall(25, 5, -30, 0);
    collideFoot(b, { x0: 22, y0: 5, x1: 24, y1: 5, vx: 35, vy: 0 }, t, []);
    expect(Math.hypot(b.vx, b.vy)).toBeLessThanOrEqual(t.maxShot + 1e-9);
  });

  it('striking underneath lifts the ball', () => {
    const b = newBall(25, 5);
    collideFoot(b, { x0: 24.2, y0: 3, x1: 24.4, y1: 4, vx: 5, vy: 20 }, t, []);
    expect(b.vy).toBeGreaterThan(0);
  });

  it('a still foot blocks: the ball rebounds slower than it arrived', () => {
    const b = newBall(26.5, 5, -20, 0);
    collideFoot(b, still(25, 5), t, []);
    expect(b.vx).toBeGreaterThan(0);
    expect(b.vx).toBeLessThan(20);
  });

  it('a foot moving with the ball leaves it almost untouched (cushion)', () => {
    const b = newBall(26.5, 5, -20, 0);
    collideFoot(b, { x0: 25.15, y0: 5, x1: 25, y1: 5, vx: -18, vy: 0 }, t, []);
    expect(b.vx).toBeLessThan(0);
    expect(Math.abs(b.vx - -18)).toBeLessThan(3);
  });

  it('one jumpy mouse reading cannot produce a full-power foot', () => {
    const f = new FootTracker(10, 5);
    for (let i = 0; i < 5; i++) f.update(10, 5, 1 / 60, t);
    // 400 m/s for a single frame.
    f.update(10 + 400 / 60, 5, 1 / 60, t);
    expect(Math.hypot(f.vx, f.vy)).toBeLessThanOrEqual(t.maxShot + 1e-9);
  });

  it('splits a frame of movement evenly over its physics steps', () => {
    const f = new FootTracker(0, 0);
    f.update(4, 0, 1 / 60, t);
    expect(f.sweep(0, 2)).toMatchObject({ x0: 0, x1: 2 });
    expect(f.sweep(1, 2)).toMatchObject({ x0: 2, x1: 4 });
  });
});
