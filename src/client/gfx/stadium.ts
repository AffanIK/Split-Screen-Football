import { ARENAS, type Palette } from '../../shared/arena';
import { GOAL_DEPTH, HALF_X, ROOF_Y, WALL_X, WORLD_W } from '../../shared/constants';
import type { Side } from '../../shared/types';
import { BUF_H, BUF_W, GROUND_PY, PPM, ctx2d, hash, makeCanvas, pixelText, py } from './pixel';
import { FAN_H, FAN_W, TEAM, fanSprite, netSprite } from './sprites';

// Rows of the buffer, top to bottom.
const ROOF_PY = py(ROOF_Y);
const UPPER_TOP = 110;
const FASCIA_TOP = 196;
const FASCIA_H = 10;
const LOWER_TOP = 206;
const BOARDS_TOP = 296;
const GOAL_W = Math.round(GOAL_DEPTH * PPM);
const WALL_PX = Math.round(WALL_X * PPM);
const ROW_STEP = 10;
const SEAT_STEP = 8;
/** Tall enough for the biggest goal Arcade mode can make. */
const NET_H = GROUND_PY - py(ROOF_Y);

type Mood = 'idle' | 'cheer' | 'sad';
type Group = Side | 'N';

interface Fan {
  x: number;
  y: number;
  shirt: number;
  skin: number;
  group: Group;
  phase: number;
  upper: boolean;
}

/**
 * The night stadium behind the pitch: sky, floodlights, two tiers of crowd, an
 * LED strip and ad boards. Everything static is painted once; the crowd, the
 * camera flashes and the LED text are drawn each frame.
 */
export class Stadium {
  private bg: HTMLCanvasElement;
  private net = netSprite(GOAL_W, NET_H);
  private fans: Fan[] = [];
  private flashes: { x: number; y: number; life: number }[] = [];
  private mood: Record<Group, { kind: Mood; until: number }> = {
    A: { kind: 'idle', until: 0 },
    B: { kind: 'idle', until: 0 },
    N: { kind: 'idle', until: 0 },
  };
  private led: HTMLCanvasElement | null = null;
  private ledText = '';
  private ledColour = '';
  private burst = 0;

  constructor(
    readonly side: Side,
    readonly practice: boolean,
    /** Each arena tints the sky and stands its own way. */
    readonly palette: Palette = ARENAS.none.palette,
  ) {
    const raw = makeCanvas(BUF_W, BUF_H);
    this.paint(ctx2d(raw));
    if (side === 'A') {
      this.bg = raw;
    } else {
      // Side B is the mirror image, so its goal is on the right.
      this.bg = makeCanvas(BUF_W, BUF_H);
      const c = ctx2d(this.bg);
      c.translate(BUF_W, 0);
      c.scale(-1, 1);
      c.drawImage(raw, 0, 0);
    }
    this.seatFans();
  }

  /** Mirror an A-frame x for side B. */
  private mx(x: number, w = 0): number {
    return this.side === 'A' ? x : BUF_W - x - w;
  }

  /** One set of fans celebrates, the other slumps. */
  celebrate(team: Side, time: number): void {
    this.mood[team] = { kind: 'cheer', until: time + 3 };
    this.mood[team === 'A' ? 'B' : 'A'] = { kind: 'sad', until: time + 3 };
    this.mood.N = { kind: 'cheer', until: time + 1.5 };
    this.burst = 40;
  }

  /** A short gasp from everyone: a save, the bar, a big shot. */
  gasp(time: number): void {
    for (const g of ['A', 'B', 'N'] as const) {
      if (this.mood[g].kind === 'idle') this.mood[g] = { kind: 'cheer', until: time + 0.5 };
    }
    this.burst = Math.max(this.burst, 8);
  }

  setLed(text: string, colour = '#ffb020'): void {
    if (text === this.ledText && colour === this.ledColour) return;
    this.ledText = text;
    this.ledColour = colour;
    this.led = pixelText(text, colour);
  }

  draw(
    ctx: CanvasRenderingContext2D,
    time: number,
    dt: number,
    ball: { x: number; speed: number } | null,
    flashes: boolean,
    goalTop: number,
  ): void {
    ctx.drawImage(this.bg, 0, 0);
    this.drawGoalBack(ctx, goalTop);

    for (const g of ['A', 'B', 'N'] as const) {
      if (time > this.mood[g].until) this.mood[g].kind = 'idle';
    }
    const ballPx = ball ? (ball.x - (this.side === 'A' ? 0 : HALF_X)) * PPM : -999;
    const lively = ball !== null && ball.speed > 14;

    for (const f of this.fans) {
      const mood = this.mood[f.group].kind;
      let up = false;
      let dy = 0;
      if (mood === 'cheer') {
        const hop = Math.sin(time * 11 + f.phase * 6.28);
        up = hop > -0.3;
        dy = hop > 0 ? -2 : 0;
      } else if (mood === 'sad') {
        dy = 1;
      } else {
        // Idle: the odd bob, arms up as a fast ball passes, a rare lone cheer.
        if (Math.sin(time * 2.2 + f.phase * 6.28) > 0.8) dy = -1;
        up = (lively && Math.abs(f.x - ballPx) < 28 && f.phase > 0.45) || Math.sin(time * 0.7 + f.phase * 90) > 0.992;
      }
      // Kept dim so the ball and boots stand out in front.
      ctx.globalAlpha = f.upper ? 0.4 : 0.62;
      ctx.drawImage(fanSprite(f.shirt, f.skin, up), f.x, f.y + dy);
    }
    ctx.globalAlpha = 1;

    if (flashes) {
      // Camera flashes: a trickle normally, a burst after something big.
      let n = Math.random() < dt * 1.5 ? 1 : 0;
      if (this.burst > 0) {
        const fire = Math.min(this.burst, Math.ceil(dt * 60));
        this.burst -= fire;
        n += fire;
      }
      for (let i = 0; i < n; i++) {
        const f = this.fans[Math.floor(Math.random() * this.fans.length)];
        if (f) this.flashes.push({ x: f.x + 2, y: f.y + 1, life: 0.12 });
      }
      ctx.fillStyle = '#ffffff';
      for (const fl of this.flashes) {
        fl.life -= dt;
        ctx.fillRect(fl.x, fl.y, 2, 2);
        if (fl.life > 0.06) {
          ctx.fillRect(fl.x - 2, fl.y, 6, 2);
          ctx.fillRect(fl.x, fl.y - 2, 2, 6);
        }
      }
      this.flashes = this.flashes.filter((fl) => fl.life > 0);
    } else {
      this.flashes.length = 0;
      this.burst = 0;
    }

    if (this.led) {
      ctx.save();
      ctx.beginPath();
      // The strip runs between the goal pillar and the inner edge (or the practice wall).
      const right = this.practice ? WALL_PX : BUF_W;
      ctx.rect(this.mx(GOAL_W, right - GOAL_W), FASCIA_TOP + 1, right - GOAL_W, FASCIA_H - 2);
      ctx.clip();
      const gap = 48;
      const span = this.led.width + gap;
      const start = -(Math.floor(time * 30) % span);
      for (let x = start; x < BUF_W; x += span) ctx.drawImage(this.led, x, FASCIA_TOP + 1);
      ctx.restore();
    }
  }

  /** Goal end behind the ball: a solid pillar above the crossbar, a dark mouth below it. */
  private drawGoalBack(ctx: CanvasRenderingContext2D, top: number): void {
    const team = TEAM[this.side];
    const x = (ax: number, w: number) => this.mx(ax, w);
    const h = top - ROOF_PY;
    ctx.fillStyle = '#1a2148';
    ctx.fillRect(x(0, GOAL_W), ROOF_PY, GOAL_W, h);
    if (h > 14) {
      ctx.fillStyle = team.dark;
      ctx.fillRect(x(10, 18), ROOF_PY, 18, h - 6);
      ctx.fillStyle = team.main;
      ctx.fillRect(x(13, 12), ROOF_PY, 12, h - 9);
      ctx.fillStyle = team.light;
      for (let y = ROOF_PY + 14; y < top - 20; y += 22) ctx.fillRect(x(16, 6), y, 6, 6);
    }
    ctx.fillStyle = '#39427a';
    ctx.fillRect(x(GOAL_W - 2, 2), ROOF_PY, 2, h);
    ctx.fillStyle = 'rgba(4,5,12,0.7)';
    ctx.fillRect(x(0, GOAL_W), top, GOAL_W, GROUND_PY - top);
  }

  /**
   * The parts of the goal that sit in front of the ball. `top` is the buffer
   * row of the crossbar; `bulge` 0..1 pushes the net back.
   */
  drawFront(ctx: CanvasRenderingContext2D, bulge: number, top: number): void {
    const GOAL_TOP = top;
    const h = GROUND_PY - GOAL_TOP;
    const slices = 6;
    const dir = this.side === 'A' ? -1 : 1;
    for (let i = 0; i < slices; i++) {
      const sy = Math.floor((i * h) / slices);
      const sh = Math.floor(((i + 1) * h) / slices) - sy;
      const push = Math.round(Math.sin(((i + 0.5) / slices) * Math.PI) * bulge * 5) * dir;
      ctx.drawImage(this.net, 0, sy, GOAL_W, sh, this.mx(0, GOAL_W) + push, GOAL_TOP + sy, GOAL_W, sh);
    }
    // Crossbar, then the near post.
    ctx.fillStyle = '#f4f6ff';
    ctx.fillRect(this.mx(0, GOAL_W + 2), GOAL_TOP - 2, GOAL_W + 2, 3);
    ctx.fillRect(this.mx(GOAL_W - 1, 3), GOAL_TOP, 3, h);
    ctx.fillStyle = '#9aa3c7';
    ctx.fillRect(this.mx(0, GOAL_W + 2), GOAL_TOP + 1, GOAL_W + 2, 1);
    ctx.fillRect(this.mx(GOAL_W + 1, 1), GOAL_TOP, 1, h);
  }

  // --- one-off painting, in side A's frame ---

  private paint(c: CanvasRenderingContext2D): void {
    // Night sky in bands.
    const sky = this.palette.sky;
    const band = Math.ceil(UPPER_TOP / sky.length);
    sky.forEach((colour, i) => {
      c.fillStyle = colour;
      c.fillRect(0, i * band, BUF_W, band);
    });
    for (let i = 0; i < 70; i++) {
      c.fillStyle = hash(i * 7) > 0.8 ? '#ffffff' : '#8f9cd4';
      c.fillRect(Math.floor(hash(i) * BUF_W), ROOF_PY + 2 + Math.floor(hash(i + 500) * 80), 1, 1);
    }

    // Floodlights: tower, lamp bank, glow.
    for (const tx of [150, 470]) {
      c.fillStyle = 'rgba(255,240,170,0.045)';
      for (const r of [90, 62, 38, 20]) {
        c.beginPath();
        c.arc(tx, 30, r, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = '#232a52';
      c.fillRect(tx - 1, 36, 3, UPPER_TOP - 36);
      c.fillRect(tx - 16, 21, 33, 15);
      for (let gy = 0; gy < 3; gy++) {
        for (let gx = 0; gx < 6; gx++) {
          c.fillStyle = (gx + gy) % 5 === 0 ? '#ffe9a0' : '#fffbe6';
          c.fillRect(tx - 14 + gx * 5, 23 + gy * 4, 4, 3);
        }
      }
    }

    // Stands.
    c.fillStyle = '#262d5a';
    c.fillRect(0, UPPER_TOP - 6, BUF_W, 6);
    c.fillStyle = this.palette.stand;
    c.fillRect(0, UPPER_TOP, BUF_W, BOARDS_TOP - UPPER_TOP);
    c.fillStyle = '#151a3a';
    for (let y = UPPER_TOP + FAN_H + 2; y < BOARDS_TOP; y += ROW_STEP) c.fillRect(0, y, BUF_W, 2);
    // Stairways.
    c.fillStyle = '#1b2148';
    for (const sx of [196, 348, 500]) {
      c.fillRect(sx, UPPER_TOP, 6, FASCIA_TOP - UPPER_TOP);
      c.fillRect(sx, LOWER_TOP, 6, BOARDS_TOP - LOWER_TOP);
    }
    // LED strip between the tiers.
    c.fillStyle = '#2b3364';
    c.fillRect(0, FASCIA_TOP - 1, BUF_W, FASCIA_H + 2);
    c.fillStyle = '#04050c';
    c.fillRect(0, FASCIA_TOP, BUF_W, FASCIA_H);

    // Ad boards along the touchline.
    c.fillStyle = '#070914';
    c.fillRect(0, BOARDS_TOP, BUF_W, GROUND_PY - BOARDS_TOP);
    const tints = ['#16306e', '#6e3410', '#1f2650', '#0f4a3a'];
    for (let i = 0, x = 0; x < BUF_W; i++, x += 80) {
      c.fillStyle = tints[i % tints.length];
      c.fillRect(x + 1, BOARDS_TOP + 2, 78, GROUND_PY - BOARDS_TOP - 4);
      c.fillStyle = 'rgba(255,255,255,0.75)';
      if (i % 2 === 0) {
        // Chevrons.
        for (let k = 0; k < 3; k++) {
          for (let s = 0; s < 6; s++) {
            c.fillRect(x + 26 + k * 10 + s, BOARDS_TOP + 6 + s, 2, 1);
            c.fillRect(x + 26 + k * 10 + s, BOARDS_TOP + 17 - s, 2, 1);
          }
        }
      } else {
        // Stripes and a ball.
        c.fillRect(x + 12, BOARDS_TOP + 8, 30, 2);
        c.fillRect(x + 12, BOARDS_TOP + 13, 22, 2);
        c.beginPath();
        c.arc(x + 58, BOARDS_TOP + 12, 5, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.fillStyle = '#4b5694';
    c.fillRect(0, BOARDS_TOP, BUF_W, 1);

    // Pitch: mown stripes that line up across the two screens.
    const greens = ['#2c8a3c', '#257834'];
    const stripe = 5 * PPM;
    const flipParity = this.side === 'B' ? 1 : 0;
    for (let i = 0; i * stripe < BUF_W; i++) {
      c.fillStyle = greens[(i + flipParity) % 2];
      c.fillRect(Math.round(i * stripe), GROUND_PY, Math.ceil(stripe), BUF_H - GROUND_PY);
    }
    for (let i = 0; i < 900; i++) {
      c.fillStyle = hash(i * 3) > 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.07)';
      c.fillRect(Math.floor(hash(i + 9000) * BUF_W), GROUND_PY + 2 + Math.floor(hash(i + 7000) * 38), 2, 1);
    }
    c.fillStyle = 'rgba(0,0,0,0.22)';
    c.fillRect(0, BUF_H - 8, BUF_W, 8);
    c.fillStyle = '#eef3ff';
    c.fillRect(0, GROUND_PY, BUF_W, 1);

    // The goal end is drawn each frame, because the goal can grow.
    c.fillStyle = this.palette.stand;
    c.fillRect(0, ROOF_PY, GOAL_W, GROUND_PY - ROOF_PY);

    if (this.practice) {
      // Rebound wall standing in for the halfway line.
      c.fillStyle = '#59618a';
      c.fillRect(WALL_PX, ROOF_PY, BUF_W - WALL_PX, GROUND_PY - ROOF_PY);
      c.fillStyle = '#3c4266';
      for (let y = ROOF_PY + 6; y < GROUND_PY; y += 12) c.fillRect(WALL_PX, y, BUF_W - WALL_PX, 1);
      for (let y = ROOF_PY; y < GROUND_PY; y += 8) {
        c.fillStyle = Math.floor(y / 8) % 2 ? '#ffd23f' : '#141936';
        c.fillRect(WALL_PX, y, 2, 8);
      }
    } else {
      // Halfway line at the inner edge.
      c.fillStyle = '#eef3ff';
      c.fillRect(BUF_W - 2, GROUND_PY, 2, BUF_H - GROUND_PY);
    }

    // Roof truss: the solid ceiling the ball bounces off.
    c.fillStyle = '#161b3c';
    c.fillRect(0, 0, BUF_W, ROOF_PY);
    c.fillStyle = '#272e5c';
    for (let x = 0; x < BUF_W; x += 16) {
      for (let s = 0; s < ROOF_PY - 2; s++) {
        c.fillRect(x + s, 1 + s, 1, 1);
        c.fillRect(x + 15 - s, 1 + s, 1, 1);
      }
    }
    c.fillStyle = '#4b5694';
    c.fillRect(0, ROOF_PY - 1, BUF_W, 1);
    c.fillStyle = '#272e5c';
    c.fillRect(0, 0, BUF_W, 1);
  }

  private seatFans(): void {
    const own = this.side;
    const rival: Side = own === 'A' ? 'B' : 'A';
    const shirtsOf: Record<Group, number[]> = { A: [0, 1], B: [2, 3], N: [4, 5, 6] };
    const rightLimit = this.practice ? WALL_PX - FAN_W : BUF_W;
    let n = 0;
    const tier = (top: number, bottom: number, upper: boolean) => {
      for (let y = top + 3, row = 0; y + FAN_H <= bottom; y += ROW_STEP, row++) {
        for (let x = GOAL_W + 4 + (row % 2) * 4; x + FAN_W <= rightLimit; x += SEAT_STEP) {
          n++;
          // Leave the stairways and a few seats empty.
          if ([196, 348, 500].some((sx) => x + FAN_W > sx && x < sx + 6)) continue;
          if (hash(n * 11) < 0.05) continue;
          // Each end is mostly its own colours. World x keeps it consistent across screens.
          const worldX = this.side === 'A' ? x / PPM : WORLD_W - x / PPM;
          const pick = hash(n * 13 + Math.floor(worldX));
          const group: Group = pick < 0.6 ? own : pick < 0.78 ? rival : 'N';
          const shirts = shirtsOf[group];
          this.fans.push({
            x: this.mx(x, FAN_W),
            y,
            shirt: shirts[Math.floor(hash(n * 17) * shirts.length)],
            skin: Math.floor(hash(n * 19) * 3),
            group,
            phase: hash(n * 23),
            upper,
          });
        }
      }
    };
    tier(UPPER_TOP, FASCIA_TOP, true);
    tier(LOWER_TOP, BOARDS_TOP, false);
  }
}
