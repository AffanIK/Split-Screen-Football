import { ARENAS, moverY, type Arena } from '../../shared/arena';
import { GOAL_H, HALF_X, ROOF_Y, WORLD_W } from '../../shared/constants';
import { ARCADE, isHazard, isPower, itemName, type ItemKind } from '../../shared/effects';
import { KEEPER_X } from '../../shared/keeper';
import type { BounceKind, Side } from '../../shared/types';
import type { View } from '../view';
import { Fx } from './fx';
import { BUF_H, BUF_W, GROUND_PY, PPM, ctx2d, makeCanvas, pixelText, px, py } from './pixel';
import {
  BALL_SIZE,
  BOOT_SIZE,
  ITEM_COLOUR,
  ITEM_SIZE,
  TEAM,
  ballSprite,
  bootSprite,
  bumperSprite,
  itemSprite,
  keeperSprite,
  portalSprite,
} from './sprites';
import { Stadium } from './stadium';

const TRAIL_SPEED = 20;

export interface DrawBall {
  x: number;
  y: number;
  angle: number;
  speed: number;
  fire?: boolean;
  /** 0..1; a ghost ball fades in as it nears the goal. */
  alpha?: number;
}

export interface DrawFoot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: 'stun' | 'frozen' | null;
  /** Super meter full. */
  charged: boolean;
}

export interface DrawItem {
  kind: ItemKind;
  x: number;
  y: number;
  /** Seconds until it can be collected; 0 once live. */
  liveIn: number;
  /** Seconds until it disappears. */
  left: number;
}

export interface Frame {
  side: Side;
  practice: boolean;
  balls: DrawBall[];
  /** Balls just handed off, sliding out of view. */
  ghosts: DrawBall[];
  /** The opponent's balls where they overlap this screen's edge. */
  remotes: { x: number; y: number }[];
  /** The boots on this half: none in menus, one normally, two in 2 v 2. */
  feet: DrawFoot[];
  /** Heights at which the opponent's shots will arrive. */
  incoming: number[];
  ballR: number;
  footR: number;
  goalH: number;
  arena: Arena | null;
  portalsOpen: boolean;
  portalSecs: number;
  items: DrawItem[];
  /** World-direction wind; 0 for none. */
  wind: number;
  /** The goalkeeper bot on this screen; null when there is none. */
  keeper: { y: number; stunned: boolean } | null;
  /** Seconds of play, which places the arena's moving parts. */
  playTime: number;
  dt: number;
  time: number;
}

/** A frame with nothing arcade in it. */
export function plainFrame(side: Side, practice: boolean, dt: number, time: number): Frame {
  return {
    side,
    practice,
    balls: [],
    ghosts: [],
    remotes: [],
    feet: [],
    incoming: [],
    ballR: 0.6,
    footR: 1,
    goalH: GOAL_H,
    arena: null,
    portalsOpen: false,
    portalSecs: 0,
    items: [],
    wind: 0,
    keeper: null,
    playTime: 0,
    dt,
    time,
  };
}

/** Draws one frame of the game into the pixel buffer and puts it on screen. */
export class Renderer {
  shakeOn = true;
  flashesOn = true;
  private buffer = makeCanvas(BUF_W, BUF_H);
  private ctx = ctx2d(this.buffer);
  private stadium: Stadium | null = null;
  private fx = new Fx();
  private shake = 0;
  private flash = 0;
  private bulge = 0;
  private squash = { a: 0, sideways: false };
  private trail: { x: number; y: number; a: number }[] = [];
  private led = '';
  private ledColour = '#ffb020';
  private x0 = 0;
  private time = 0;
  /** Goal height as drawn; it eases towards the real one so growth is visible. */
  private goalShown = GOAL_H;
  private lit = new Map<string, number>();
  private padHit = -10;

  setLed(text: string, colour = '#ffb020'): void {
    this.led = text;
    this.ledColour = colour;
  }

  onBounce(kind: BounceKind, speed: number, x: number, y: number): void {
    const sideways = kind === 'wall' || kind === 'board' || kind === 'net';
    this.squash = { a: Math.min(0.35, speed / 45), sideways };
    const bx = px(x, this.x0);
    const by = py(y);
    if (kind === 'ground') this.fx.grass(bx, Math.min(1, speed / 25));
    else if (kind === 'post') this.fx.sparks(bx, by);
    else if (kind === 'roof' && speed > 8) this.fx.sparks(bx, by - 6, '#8f9cd4');
    else if (kind === 'net') this.bulge = Math.min(1, 0.3 + speed / 25);
  }

  onKick(power: number, x: number, y: number, vx: number, vy: number): void {
    const s = Math.hypot(vx, vy) || 1;
    this.fx.impact(px(x, this.x0), py(y), vx / s, -vy / s, power);
  }

  /** A bumper at this world position was hit. */
  onBumper(x: number, y: number): void {
    this.lit.set(`${Math.round(x)},${Math.round(y)}`, this.time);
    // Sliding bumpers are remembered by their column, since their height changes.
    this.lit.set(Math.round(x) + ',m', this.time);
    this.fx.burst(px(x, this.x0), py(y), '#ffd23f', 12);
  }

  onPad(x: number): void {
    this.padHit = this.time;
    this.fx.grass(px(x, this.x0), 1);
  }

  /** A burst of sparkles in the world: a portal, a pickup. */
  sparkle(x: number, y: number, colour: string): void {
    this.fx.burst(px(x, this.x0), py(y), colour);
  }

  addShake(amount: number): void {
    if (this.shakeOn) this.shake = Math.max(this.shake, amount);
  }

  /** White flash for a screamer. */
  addFlash(): void {
    if (this.flashesOn) this.flash = 0.6;
  }

  celebrate(team: Side): void {
    this.stadium?.celebrate(team, this.time);
    const t = TEAM[team];
    this.fx.confetti([t.main, t.light, '#ffffff', '#ffd23f']);
  }

  gasp(): void {
    this.stadium?.gasp(this.time);
  }

  /** Draw a frame and put it on screen. */
  draw(out: CanvasRenderingContext2D, view: View, f: Frame): void {
    const { buffer, sx, sy } = this.render(f);
    view.present(out, [buffer], sx, sy);
  }

  /** Draw a frame into this renderer's buffer. Returns it with this frame's screen shake. */
  render(f: Frame): { buffer: HTMLCanvasElement; sx: number; sy: number } {
    const ctx = this.ctx;
    this.time = f.time;
    this.x0 = f.side === 'A' ? 0 : HALF_X;
    const palette = (f.arena ?? ARENAS.none).palette;
    if (
      !this.stadium ||
      this.stadium.side !== f.side ||
      this.stadium.practice !== f.practice ||
      this.stadium.palette !== palette
    ) {
      this.stadium = new Stadium(f.side, f.practice, palette);
      this.goalShown = f.goalH;
    }
    const stadium = this.stadium;
    stadium.setLed(this.led, this.ledColour === '#ffb020' ? palette.led : this.ledColour);

    this.shake = Math.max(0, this.shake - f.dt * 4);
    this.flash = Math.max(0, this.flash - f.dt * 4);
    this.bulge = Math.max(0, this.bulge - f.dt * 2.5);
    this.squash.a = Math.max(0, this.squash.a - f.dt * 3);
    this.goalShown += (f.goalH - this.goalShown) * Math.min(1, f.dt * 5);
    const goalTop = py(this.goalShown);

    // The crowd watches a ball while it is on this screen.
    const watched = f.balls[0] ? { x: f.balls[0].x, speed: f.balls[0].speed } : null;
    stadium.draw(ctx, f.time, f.dt, watched, this.flashesOn, goalTop);

    if (f.arena) this.drawArena(f);
    if (f.wind) this.fx.wind(Math.sign(f.wind), f.dt);

    // Shadows on the grass shrink as things rise.
    for (const b of [...f.balls, ...f.ghosts]) if ((b.alpha ?? 1) > 0.5) this.shadow(b.x, b.y, f.ballR * PPM);
    for (const foot of f.feet) this.shadow(foot.x, foot.y, f.footR * PPM * 0.85);

    if (f.keeper) this.drawKeeper(f);
    for (const y of f.incoming) this.chevrons(f.side, y, f.time);
    for (const item of f.items) this.drawItem(item, f.time);

    // Speed streaks behind a fast ball.
    for (const b of f.balls) {
      if (b.speed > TRAIL_SPEED && (b.alpha ?? 1) > 0.5) this.trail.push({ x: b.x, y: b.y, a: 1 });
      if (b.fire) this.fx.flame(px(b.x, this.x0), py(b.y));
    }
    for (const p of this.trail) p.a -= f.dt * 7;
    this.trail = this.trail.filter((p) => p.a > 0);
    for (const p of this.trail) {
      const s = p.a > 0.66 ? 5 : p.a > 0.33 ? 3 : 2;
      ctx.fillStyle = p.a > 0.5 ? '#dfe6ff' : '#7f8cc4';
      ctx.fillRect(px(p.x, this.x0) - (s >> 1), py(p.y) - (s >> 1), s, s);
    }

    for (const r of f.remotes) this.ball({ x: r.x, y: r.y, angle: 0, speed: 0 }, f.ballR, 0);
    for (const g of f.ghosts) this.ball(g, f.ballR, 0);
    f.balls.forEach((b, i) => this.ball(b, f.ballR, i === 0 ? this.squash.a : 0));

    stadium.drawFront(ctx, this.bulge, goalTop);

    for (const foot of f.feet) this.boot(f, foot);

    this.fx.draw(ctx, f.dt);

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash})`;
      ctx.fillRect(0, 0, BUF_W, BUF_H);
    }

    const sh = Math.round(this.shake * this.shake * 12);
    const sx = sh ? Math.round((Math.random() * 2 - 1) * sh) : 0;
    const sy = sh ? Math.round((Math.random() * 2 - 1) * sh) : 0;
    return { buffer: this.buffer, sx, sy };
  }

  /** Arena objects are defined in side A's frame; side B sees the mirror image. */
  private wx(f: Frame, ax: number): number {
    return f.side === 'A' ? ax : WORLD_W - ax;
  }

  private drawArena(f: Frame): void {
    const ctx = this.ctx;
    const arena = f.arena!;

    if (arena.roof < ROOF_Y) {
      // A lowered ceiling: solid from the stadium roof down to it.
      const top = py(ROOF_Y);
      const bottom = py(arena.roof);
      ctx.fillStyle = '#161b3c';
      ctx.fillRect(0, top, BUF_W, bottom - top);
      ctx.fillStyle = '#272e5c';
      for (let x = 0; x < BUF_W; x += 24) ctx.fillRect(x, top, 2, bottom - top);
      ctx.fillStyle = '#4b5694';
      ctx.fillRect(0, bottom - 2, BUF_W, 2);
    }

    for (const k of arena.blocks) {
      const a = px(this.wx(f, k.x0), this.x0);
      const b = px(this.wx(f, k.x1), this.x0);
      const left = Math.min(a, b);
      const w = Math.abs(b - a);
      const top = py(k.y1);
      const h = py(k.y0) - top;
      ctx.fillStyle = '#39427a';
      ctx.fillRect(left, top, w, h);
      ctx.fillStyle = '#59638f';
      ctx.fillRect(left, top, w, 2);
      ctx.fillRect(left, top, 2, h);
      ctx.fillStyle = '#1b2148';
      ctx.fillRect(left + w - 2, top, 2, h);
      for (let y = top + 8; y < top + h - 2; y += 10) ctx.fillRect(left + 3, y, w - 6, 1);
    }

    const sp = arena.spinner;
    if (sp) {
      // Side B sees the mirror image, so its bar turns the other way.
      const turn = sp.speed * f.playTime;
      const ux = Math.cos(turn) * (f.side === 'A' ? 1 : -1);
      const uy = Math.sin(turn);
      const cx = px(this.wx(f, sp.x), this.x0);
      const cy = py(sp.y);
      const half = (sp.len / 2) * PPM;
      const thick = Math.max(2, Math.round(sp.thick * PPM));
      for (let d = -half; d <= half; d += 2) {
        ctx.fillStyle = Math.abs(d) > half - 8 ? '#ffd23f' : '#c9cfe6';
        ctx.fillRect(Math.round(cx + ux * d) - thick, Math.round(cy - uy * d) - thick, thick * 2, thick * 2);
      }
      ctx.fillStyle = '#39427a';
      ctx.fillRect(cx - 5, cy - 5, 10, 10);
      ctx.fillStyle = '#ffd23f';
      ctx.fillRect(cx - 2, cy - 2, 4, 4);
    }

    for (const m of arena.movers) {
      const r = Math.round(m.r * PPM);
      const x = this.wx(f, m.x);
      const cx = px(x, this.x0);
      // The rail it slides on.
      ctx.fillStyle = 'rgba(201,207,230,0.25)';
      ctx.fillRect(cx - 1, py(m.y + m.amp), 2, py(m.y - m.amp) - py(m.y + m.amp));
      const y = moverY(m, f.playTime);
      const hit = this.lit.get(Math.round(x) + ',m') ?? -10;
      ctx.drawImage(bumperSprite(r, this.time - hit < 0.15), cx - r, py(y) - r);
    }

    for (const [from, to] of arena.pads) {
      const a = px(this.wx(f, from), this.x0);
      const b = px(this.wx(f, to), this.x0);
      const left = Math.min(a, b);
      const w = Math.abs(b - a);
      // The pad dips for a moment when something lands on it.
      const dip = this.time - this.padHit < 0.12 ? 2 : 0;
      ctx.fillStyle = '#141936';
      ctx.fillRect(left, GROUND_PY - 5 + dip, w, 6 - dip);
      for (let x = 0; x < w; x += 8) {
        ctx.fillStyle = (x / 8) % 2 ? '#ffd23f' : '#ff8a2a';
        ctx.fillRect(left + x, GROUND_PY - 5 + dip, Math.min(8, w - x), 2);
      }
      ctx.fillStyle = '#9aa3c7';
      for (let x = 3; x < w - 2; x += 6) ctx.fillRect(left + x, GROUND_PY - 2 + dip, 2, 2);
    }

    for (const bump of arena.bumpers) {
      const r = Math.round(bump.r * PPM);
      const x = this.wx(f, bump.x);
      const hit = this.lit.get(`${Math.round(x)},${Math.round(bump.y)}`) ?? -10;
      ctx.drawImage(bumperSprite(r, this.time - hit < 0.15), px(x, this.x0) - r, py(bump.y) - r);
    }

    if (arena.portals) {
      const frame = Math.floor(f.time * 8) % 4;
      const secs = String(Math.ceil(f.portalSecs));
      for (const p of arena.portals) {
        const r = Math.round(p.r * PPM);
        const cx = px(this.wx(f, p.x), this.x0);
        const cy = py(p.y);
        ctx.drawImage(portalSprite(r, f.portalsOpen, frame), cx - r, cy - r);
        // Seconds until it opens, or until it shuts.
        const label = pixelText(secs, f.portalsOpen ? '#e6c9ff' : '#7c86a8');
        ctx.drawImage(label, cx - (label.width >> 1), cy - r - 11);
      }
    }
  }

  private drawItem(item: DrawItem, time: number): void {
    const ctx = this.ctx;
    const cx = px(item.x, this.x0);
    const cy = item.kind === 'mud' ? GROUND_PY : py(item.y);
    const half = (ITEM_SIZE - 1) / 2;
    const sprite = itemSprite(item.kind);
    const hazard = isHazard(item.kind);
    const tint = hazard ? '#ff5c5c' : '#ffd23f';

    if (item.liveIn > 0) {
      // Coming soon: a pulsing dashed ring, a faint icon, and what and when.
      const pulse = 12 + Math.round((item.liveIn % 1) * 8);
      ctx.fillStyle = tint;
      for (let i = 0; i < 16; i += 2) {
        const a = (i / 16) * Math.PI * 2 + time * 2;
        ctx.fillRect(cx + Math.round(Math.cos(a) * pulse), cy + Math.round(Math.sin(a) * pulse), 2, 2);
      }
      ctx.globalAlpha = 0.45;
      ctx.drawImage(sprite, cx - half, cy - half);
      ctx.globalAlpha = 1;
      this.label(`${itemName(item.kind)} ${Math.ceil(item.liveIn)}`, cx, cy - 28, tint);
      return;
    }

    if (item.kind === 'mud') {
      // A muddy strip of ground.
      const w = Math.round(ARCADE.mudHalfWidth * 2 * PPM);
      for (let x = 0; x < w; x += 2) {
        ctx.fillStyle = (x / 2) % 3 ? '#5c3a1a' : '#8a5a2b';
        ctx.fillRect(cx - (w >> 1) + x, GROUND_PY - ((x * 7) % 3), 2, 5 + ((x * 7) % 3));
      }
      this.label(`MUD ${Math.ceil(item.left)}`, cx, GROUND_PY - 14, tint);
      return;
    }

    if (item.kind === 'well') {
      // Rings drawn in towards the centre show how far the pull reaches.
      const reach = ARCADE.wellRange * PPM;
      ctx.fillStyle = '#c77dff';
      for (let ring = 0; ring < 3; ring++) {
        const r = reach * (1 - ((time * 0.6 + ring / 3) % 1));
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * Math.PI * 2 + ring;
          ctx.fillRect(cx + Math.round(Math.cos(a) * r), cy + Math.round(Math.sin(a) * r), 2, 2);
        }
      }
      ctx.drawImage(sprite, cx - half, cy - half);
      this.label(String(Math.ceil(item.left)), cx, cy - 22, tint);
      return;
    }

    const bob = item.kind === 'mine' ? 0 : Math.round(Math.sin(time * 4 + item.x) * 2);
    // A slow halo so it stands out against the crowd.
    const halo = 11 + (Math.floor(time * 6) % 3);
    ctx.fillStyle = isPower(item.kind) ? ITEM_COLOUR[item.kind] : hazard ? '#ff3b3b' : '#ffffff';
    ctx.globalAlpha = hazard && Math.floor(time * 6) % 2 ? 0.7 : 0.35;
    ctx.fillRect(cx - halo, cy + bob - 1, halo * 2, 2);
    ctx.fillRect(cx - 1, cy + bob - halo, 2, halo * 2);
    ctx.globalAlpha = 1;
    ctx.drawImage(sprite, cx - half, cy - half + bob);
  }

  /** A short line of text on a dark plate, centred on x and kept on screen. */
  private label(text: string, cx: number, top: number, colour: string): void {
    const ctx = this.ctx;
    const img = pixelText(text, colour);
    const x = Math.max(2, Math.min(BUF_W - img.width - 2, cx - (img.width >> 1)));
    ctx.fillStyle = 'rgba(5,7,15,0.75)';
    ctx.fillRect(x - 2, top - 2, img.width + 4, 12);
    ctx.drawImage(img, x, top);
  }

  private drawKeeper(f: Frame): void {
    const ctx = this.ctx;
    const k = f.keeper!;
    const sprite = keeperSprite();
    const cx = px(this.wx(f, KEEPER_X), this.x0);
    const cy = py(k.y);
    const w = sprite.width * 2;
    const h = sprite.height * 2;
    if (k.stunned) ctx.globalAlpha = 0.5;
    ctx.drawImage(sprite, cx - (w >> 1), cy - (h >> 1), w, h);
    ctx.globalAlpha = 1;
    if (k.stunned) {
      ctx.fillStyle = '#ffd23f';
      for (let i = 0; i < 3; i++) {
        const a = f.time * 9 + (i * Math.PI * 2) / 3;
        ctx.fillRect(cx + Math.round(Math.cos(a) * 12) - 1, cy - (h >> 1) - 5 + Math.round(Math.sin(a) * 3), 3, 1);
      }
    }
  }
  private boot(f: Frame, foot: DrawFoot): void {
    const ctx = this.ctx;
    const dir = f.side === 'A' ? 1 : -1;
    const lean = foot.vy * 0.03 - foot.vx * dir * 0.008;
    const size = Math.round(BOOT_SIZE * f.footR);
    const cx = px(foot.x, this.x0);
    const cy = py(foot.y);
    const left = cx - (size >> 1);
    const top = cy - (size >> 1);

    if (foot.state) ctx.globalAlpha = 0.55;
    ctx.drawImage(bootSprite(f.side, lean), left, top, size, size);
    ctx.globalAlpha = 1;

    if (foot.state === 'frozen') {
      // Blocks of ice over the boot.
      ctx.fillStyle = 'rgba(160,232,255,0.6)';
      for (let y = 0; y < size; y += 4) {
        for (let x = (y / 4) % 2 ? 0 : 2; x < size; x += 4) ctx.fillRect(left + x, top + y, 2, 2);
      }
    } else if (foot.state === 'stun') {
      // Stars circling overhead.
      ctx.fillStyle = '#ffd23f';
      for (let i = 0; i < 3; i++) {
        const a = f.time * 9 + (i * Math.PI * 2) / 3;
        const sx = cx + Math.round(Math.cos(a) * (size * 0.45));
        const sy = top - 4 + Math.round(Math.sin(a) * 3);
        ctx.fillRect(sx - 1, sy, 3, 1);
        ctx.fillRect(sx, sy - 1, 1, 3);
      }
    } else if (foot.charged) {
      // Flames licking round a boot that is ready to fire.
      this.fx.flame(cx + Math.round((Math.random() - 0.5) * size * 0.6), cy + (size >> 2));
      if (Math.floor(f.time * 8) % 2) {
        ctx.fillStyle = '#ffd23f';
        ctx.fillRect(left - 2, cy, 2, 2);
        ctx.fillRect(left + size, cy, 2, 2);
        ctx.fillRect(cx, top - 2, 2, 2);
      }
    }
  }

  private ball(b: DrawBall, radius: number, squash: number): void {
    const alpha = b.alpha ?? 1;
    if (alpha <= 0.02) return;
    const size = Math.round(BALL_SIZE * (radius / 0.6));
    let w = size;
    let h = size;
    if (squash > 0.04) {
      // Flatten against the surface it hit.
      if (this.squash.sideways) {
        w = Math.round(size * (1 - squash));
        h = Math.round(size * (1 + squash * 0.5));
      } else {
        w = Math.round(size * (1 + squash * 0.5));
        h = Math.round(size * (1 - squash));
      }
    }
    const ctx = this.ctx;
    const x = px(b.x, this.x0);
    const y = py(b.y);
    if (b.fire) {
      ctx.fillStyle = Math.floor(this.time * 20) % 2 ? '#ff8a2a' : '#ffd23f';
      ctx.fillRect(x - (w >> 1) - 2, y - (h >> 1) + 2, w + 4, h - 4);
      ctx.fillRect(x - (w >> 1) + 2, y - (h >> 1) - 2, w - 4, h + 4);
    }
    ctx.globalAlpha = alpha;
    ctx.drawImage(ballSprite(b.angle), x - (w >> 1), y - (h >> 1), w, h);
    ctx.globalAlpha = 1;
  }

  private shadow(x: number, y: number, radius: number): void {
    const w = Math.max(2, Math.round(radius * 2 - Math.min(radius, y * 0.5)));
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(px(x, this.x0) - (w >> 1), GROUND_PY + 3, w, 2);
    ctx.fillRect(px(x, this.x0) - (w >> 1) + 1, GROUND_PY + 2, Math.max(0, w - 2), 4);
  }

  /** Flashing arrows at the inner edge where the opponent's shot will arrive. */
  private chevrons(side: Side, y: number, time: number): void {
    const ctx = this.ctx;
    const dir = side === 'A' ? -1 : 1;
    const edge = side === 'A' ? BUF_W - 1 : 0;
    const cy = Math.min(GROUND_PY - 8, Math.max(24, py(y)));
    const blink = Math.floor(time * 10) % 3;
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = k === blink ? '#ffffff' : '#ffd23f';
      const tip = edge + dir * (6 + k * 9);
      for (let s = 0; s < 7; s++) {
        ctx.fillRect(tip - dir * s - (dir > 0 ? 2 : 0), cy - s, 3, 1);
        ctx.fillRect(tip - dir * s - (dir > 0 ? 2 : 0), cy + s, 3, 1);
      }
    }
  }
}
