import { BUMPER_GAIN, BUMPER_MIN_SPEED, PAD_GAIN, PAD_MIN_SPEED, SOLID_BOUNCE, moverY, type Bumper } from './arena';
import { GOAL_DEPTH, GOAL_H, ROOF_Y, WALL_X, WORLD_W, type Tuning } from './constants';
import { ARCADE } from './effects';
import { collideFoot, type FootSweep } from './foot';
import type { Ball, BounceKind, Side, SimEvent, World } from './types';

/** Impacts slower than this are silent. */
const QUIET = 1;
/** A fireball that slows below this goes out. */
const FIRE_OUT_SPEED = 12;
/** The keeper parries softly, so the rebound stays in play near the goal. */
const KEEPER_SOFT = 0.1;
const KEEPER_HARD = 0.3;

function mirrorBall(b: Ball): void {
  b.x = WORLD_W - b.x;
  b.vx = -b.vx;
}

function mirrorSweep(f: FootSweep): FootSweep {
  return { ...f, x0: WORLD_W - f.x0, x1: WORLD_W - f.x1, vx: -f.vx };
}

/** Top speed for this ball right now. */
export function speedCap(b: Ball, t: Tuning): number {
  return t.maxShot * (b.fire ? ARCADE.fireMult : 1);
}

function clampSpeed(b: Ball, t: Tuning): void {
  const cap = speedCap(b, t);
  const speed = Math.hypot(b.vx, b.vy);
  if (speed > cap) {
    b.vx *= cap / speed;
    b.vy *= cap / speed;
  }
}

/**
 * Advance the ball one fixed step on one half of the pitch. Side B is the
 * mirror image of side A, so the step always runs in A's frame (goal at x = 0).
 * `foot` may be one sweep or several (two boots on a side in 2 v 2).
 */
export function stepWorld(
  b: Ball,
  foot: FootSweep | readonly FootSweep[] | null,
  dt: number,
  world: World,
  t: Tuning,
  ev: SimEvent[],
): void {
  b.px = b.x;
  b.py = b.y;
  const from = ev.length;
  // Wind blows the same way on both screens, so it is applied before mirroring.
  if (world.wind && b.y > t.ballRadius + 0.05) b.vx += world.wind * dt;

  const flip = world.side === 'B';
  if (flip) mirrorBall(b);

  b.vy -= t.gravity * dt;
  for (const w of world.wells ?? []) {
    const dx = w.x - b.x;
    const dy = w.y - b.y;
    const d = Math.hypot(dx, dy);
    if (d < ARCADE.wellRange && d > 0.3) {
      // Stronger the closer the ball gets.
      const pull = ARCADE.wellPull * (1 - d / ARCADE.wellRange) * dt;
      b.vx += (dx / d) * pull;
      b.vy += (dy / d) * pull;
    }
  }
  const drag = Math.max(0, 1 - t.airDrag * dt);
  b.vx *= drag;
  b.vy *= drag;
  // The cap is also the top speed in flight, so a long fall can never
  // produce a ball faster than the server accepts.
  clampSpeed(b, t);
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  if (foot) {
    const sweeps: readonly FootSweep[] = Array.isArray(foot) ? foot : [foot as FootSweep];
    for (const f of sweeps) collideFoot(b, flip ? mirrorSweep(f) : f, t, ev);
  }
  if (world.keeper) collideKeeper(b, world.keeper, t, ev);
  constrain(b, dt, world, t, ev);
  clampSpeed(b, t);

  if (b.fire && Math.hypot(b.vx, b.vy) < FIRE_OUT_SPEED) b.fire = false;
  if (b.warp > 0) b.warp -= dt;

  if (flip) {
    mirrorBall(b);
    // Events were recorded in side A's frame; turn them back into world coordinates.
    for (let i = from; i < ev.length; i++) {
      const e = ev[i];
      if ('x' in e) e.x = WORLD_W - e.x;
      if ('vx' in e) e.vx = -e.vx;
    }
  }
  if (b.onGround) b.spin = -b.vx / t.ballRadius;
  b.angle += b.spin * dt;
}

/** The keeper is a round body swept along its rail; it uses the same contact rule as a boot. */
function collideKeeper(b: Ball, k: NonNullable<World['keeper']>, t: Tuning, ev: SimEvent[]): void {
  const wasFire = b.fire;
  const touches: SimEvent[] = [];
  const body = { ...t, footRadius: k.r, kickSoft: KEEPER_SOFT, kickHard: KEEPER_HARD };
  collideFoot(b, { x0: k.x, y0: k.y0, x1: k.x, y1: k.y1, vx: 0, vy: k.vy }, body, touches);
  if (!touches.some((e) => e.type === 'kick')) return;
  // A fireball is beaten out, but it goes out and the keeper pays for it.
  b.fire = false;
  ev.push({ type: 'keeper', x: b.x, y: b.y, fire: wasFire });
}

function bounce(ev: SimEvent[], kind: BounceKind, speed: number, b: Ball): void {
  if (speed > QUIET) ev.push({ type: 'bounce', kind, speed, x: b.x, y: b.y });
}

/** Push the ball out of a round object. Returns the outward normal if it was touching. */
function outOfCircle(b: Ball, c: Bumper, r: number): [number, number] | null {
  const dx = b.x - c.x;
  const dy = b.y - c.y;
  const reach = c.r + r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= reach * reach) return null;
  const d = Math.sqrt(d2) || 1;
  b.x = c.x + (dx / d) * reach;
  b.y = c.y + (dy / d) * reach;
  return [dx / d, dy / d];
}

/** Bounce the ball off a surface moving at (sx, sy), keeping `keep` of its speed into it. */
function reflect(b: Ball, nx: number, ny: number, keep: number, sx = 0, sy = 0): number {
  const vn = (b.vx - sx) * nx + (b.vy - sy) * ny;
  if (vn >= 0) return 0;
  b.vx -= (1 + keep) * vn * nx;
  b.vy -= (1 + keep) * vn * ny;
  return -vn;
}

function constrain(b: Ball, dt: number, world: World, t: Tuning, ev: SimEvent[]): void {
  const r = t.ballRadius;
  const goalH = world.goalH ?? GOAL_H;
  const arena = world.arena;
  const roof = arena?.roof ?? ROOF_Y;
  const time = world.time ?? 0;

  if (arena) {
    // Bumpers, fixed and sliding.
    const bumps: Bumper[] = arena.movers.length
      ? [...arena.bumpers, ...arena.movers.map((m) => ({ x: m.x, y: moverY(m, time), r: m.r }))]
      : arena.bumpers;
    for (const bump of bumps) {
      const n = outOfCircle(b, bump, r);
      if (!n) continue;
      const vn = b.vx * n[0] + b.vy * n[1];
      if (vn < 0) {
        // Reflect, then leave a little faster than it arrived.
        b.vx -= 2 * vn * n[0];
        b.vy -= 2 * vn * n[1];
        const speed = Math.hypot(b.vx, b.vy);
        const out = Math.max(BUMPER_MIN_SPEED, speed * BUMPER_GAIN);
        b.vx *= out / speed;
        b.vy *= out / speed;
        ev.push({ type: 'bumper', x: bump.x, y: bump.y });
      }
    }

    // The windmill: a bar turning about its middle, which swats the ball as well as blocking it.
    const s = arena.spinner;
    if (s) {
      const a = s.speed * time;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const along = Math.max(-s.len / 2, Math.min(s.len / 2, (b.x - s.x) * ux + (b.y - s.y) * uy));
      const cx = s.x + ux * along;
      const cy = s.y + uy * along;
      const n = outOfCircle(b, { x: cx, y: cy, r: s.thick }, r);
      if (n) {
        // Speed of the bar at the point of contact.
        const hit = reflect(b, n[0], n[1], SOLID_BOUNCE, -s.speed * (cy - s.y), s.speed * (cx - s.x));
        bounce(ev, 'wall', hit, b);
      }
    }

    for (const k of arena.blocks) {
      const cx = Math.max(k.x0, Math.min(k.x1, b.x));
      const cy = Math.max(k.y0, Math.min(k.y1, b.y));
      if (cx === b.x && cy === b.y) {
        // Centre inside the block: leave by the nearest face.
        const left = b.x - k.x0;
        const right = k.x1 - b.x;
        const down = b.y - k.y0;
        const up = k.y1 - b.y;
        const m = Math.min(left, right, down, up);
        if (m === left) b.x = k.x0 - r;
        else if (m === right) b.x = k.x1 + r;
        else if (m === up) b.y = k.y1 + r;
        else b.y = k.y0 - r;
        continue;
      }
      const n = outOfCircle(b, { x: cx, y: cy, r: 0 }, r);
      if (n) bounce(ev, 'wall', reflect(b, n[0], n[1], SOLID_BOUNCE), b);
    }

    if (arena.portals && world.portalsOpen && b.warp <= 0) {
      const [p, q] = arena.portals;
      for (const [from, to] of [
        [p, q],
        [q, p],
      ]) {
        if (Math.hypot(b.x - from.x, b.y - from.y) < from.r) {
          b.x = to.x;
          b.y = to.y;
          b.warp = 0.5;
          ev.push({ type: 'portal', x: to.x, y: to.y });
          break;
        }
      }
    }
  }

  // Crossbar: a horizontal bar over the net, ending at the goal line.
  const n = outOfCircle(b, { x: Math.min(GOAL_DEPTH, Math.max(0, b.x)), y: goalH, r: 0 }, r);
  if (n) bounce(ev, 'post', reflect(b, n[0], n[1], t.wallBounce), b);

  // Back wall above the crossbar keeps high balls in play.
  if (b.y > goalH && b.x < GOAL_DEPTH + r) {
    b.x = GOAL_DEPTH + r;
    if (b.vx < 0) {
      bounce(ev, 'board', -b.vx, b);
      b.vx = -b.vx * t.wallBounce;
    }
  }

  // Back of the net.
  if (b.x < r) {
    b.x = r;
    if (b.vx < 0) {
      bounce(ev, 'net', -b.vx, b);
      b.vx = -b.vx * t.netBounce;
    }
  }

  if (world.wall && b.x > WALL_X - r) {
    b.x = WALL_X - r;
    if (b.vx > 0) {
      bounce(ev, 'wall', b.vx, b);
      b.vx = -b.vx * t.wallBounce;
    }
  }

  if (b.y > roof - r) {
    b.y = roof - r;
    if (b.vy > 0) {
      bounce(ev, 'roof', b.vy, b);
      b.vy = -b.vy * t.wallBounce;
    }
  }

  b.onGround = false;
  if (b.y <= r) {
    b.y = r;
    const onPad = !!arena && arena.pads.some(([from, to]) => b.x >= from && b.x <= to);
    const inMud = !!world.mud && world.mud.some(([from, to]) => b.x >= from && b.x <= to);
    if (onPad) {
      // A trampoline always throws the ball back up.
      b.vy = Math.max(PAD_MIN_SPEED, -b.vy * PAD_GAIN);
      ev.push({ type: 'pad', x: b.x, y: b.y });
    } else if (b.vy < 0) {
      const s = -b.vy;
      if (s < t.restSpeed || inMud) {
        // Mud swallows the bounce.
        if (inMud) bounce(ev, 'ground', s * 0.5, b);
        b.vy = 0;
      } else {
        b.vy = s * t.groundBounce;
        bounce(ev, 'ground', s, b);
      }
    }
    if (b.vy === 0) {
      b.onGround = true;
      const dv = t.rollFriction * (inMud ? ARCADE.mudFriction : 1) * dt;
      b.vx = Math.abs(b.vx) <= dv ? 0 : b.vx - Math.sign(b.vx) * dv;
    }
  }
}

/** The whole ball is over the goal line and under the crossbar. */
export function isGoal(b: Ball, side: Side, t: Tuning, goalH = GOAL_H): boolean {
  const lx = side === 'A' ? b.x : WORLD_W - b.x;
  return lx + t.ballRadius < GOAL_DEPTH && b.y < goalH;
}
