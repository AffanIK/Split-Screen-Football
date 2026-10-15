import { DT, tuning } from '../../shared/constants';
import { FootTracker } from '../../shared/foot';
import { stepWorld } from '../../shared/physics';
import { newBall, type Ball } from '../../shared/types';
import { PPM, ctx2d } from '../gfx/pixel';
import { BALL_SIZE, BOOT_SIZE, ballSprite, bootSprite } from '../gfx/sprites';

const W = 128;
const H = 64;
const GROUND = 56;
/** The demos run in a quiet patch of pitch, far from the goal, roof and halfway line. */
const OX = 20;

type Vec = [number, number];

interface Move {
  title: string;
  text: string;
  /** Loop length in seconds. */
  dur: number;
  /** Ball start: x, y, vx, vy in the demo's own 10 m x 4.4 m window. */
  ball: [number, number, number, number];
  foot: Vec;
  /** Where the foot should be at time t; it may watch the ball. */
  path: (t: number, ball: Ball, foot: Vec) => Vec;
}

/** Move towards a target at a set speed. */
function toward(from: Vec, to: Vec, speed: number): Vec {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const d = Math.hypot(dx, dy);
  const step = speed * DT;
  return d <= step ? to : [from[0] + (dx / d) * step, from[1] + (dy / d) * step];
}

const MOVES: Move[] = [
  {
    title: 'DRIBBLE',
    text: 'WALK INTO THE BALL AND KEEP PUSHING',
    dur: 3.4,
    ball: [3, 0.6, 0, 0],
    foot: [0.8, 0.9],
    path: (_t, _b, f) => toward(f, [8.6, 0.9], 3),
  },
  {
    title: 'SHOOT',
    text: 'SWIPE FAST THROUGH THE BALL',
    dur: 2.2,
    ball: [4, 0.6, 0, 0],
    foot: [1, 1],
    path: (t, _b, f) => (t < 0.6 ? f : toward(f, [6.5, 1.1], 30)),
  },
  {
    title: 'CHIP',
    text: 'SWIPE UP UNDER THE BALL',
    dur: 2.6,
    ball: [5, 0.6, 0, 0],
    foot: [2.6, 0.2],
    path: (t, _b, f) => (t < 0.6 ? f : toward(f, [5.6, 3.2], 22)),
  },
  {
    title: 'JUGGLE',
    text: 'FLICK UP UNDER IT AGAIN AND AGAIN',
    dur: 4,
    ball: [5, 3.6, 0, 0],
    foot: [5, 1.1],
    path: (_t, b, f) => {
      const x = f[0] + (b.x - OX - f[0]) * 0.2;
      // Rise to meet a falling ball, then drop back.
      const meet = b.vy < 0 && b.y - f[1] < 2.2;
      return toward([x, f[1]], [x, meet ? 2 : 1.1], meet ? 9 : 5);
    },
  },
  {
    title: 'CUSHION',
    text: 'MOVE WITH THE BALL TO KILL ITS PACE',
    dur: 3,
    ball: [9.6, 2.2, -12, 3],
    foot: [5.6, 2.2],
    // Line up with the ball, then back away with it for a moment as it arrives.
    path: (t, b, f) => {
      if (t < 0.22) return [f[0], f[1] + (b.y - f[1]) * 0.25];
      return t < 0.5 ? toward(f, [f[0] - 3, f[1]], 9) : f;
    },
  },
  {
    title: 'BLOCK',
    text: 'HOLD STILL IN ITS PATH',
    dur: 2.6,
    ball: [9.6, 2.2, -17, 3],
    foot: [4.6, 2.2],
    path: (t, b, f) => (t < 0.15 ? [f[0], f[1] + (b.y - f[1]) * 0.25] : f),
  },
];

class Demo {
  private ctx: CanvasRenderingContext2D;
  private ball!: Ball;
  private foot!: FootTracker;
  private t = 0;
  private acc = 0;

  constructor(
    private move: Move,
    canvas: HTMLCanvasElement,
  ) {
    canvas.width = W;
    canvas.height = H;
    this.ctx = ctx2d(canvas);
    this.reset();
  }

  private reset(): void {
    const [x, y, vx, vy] = this.move.ball;
    this.ball = newBall(OX + x, y, vx, vy);
    this.foot = new FootTracker(OX + this.move.foot[0], this.move.foot[1]);
    this.t = 0;
  }

  tick(dt: number): void {
    this.acc += dt;
    while (this.acc >= DT) {
      this.acc -= DT;
      this.t += DT;
      if (this.t >= this.move.dur) this.reset();
      const [fx, fy] = this.move.path(this.t, this.ball, [this.foot.x - OX, this.foot.y]);
      this.foot.update(OX + fx, fy, DT, tuning);
      stepWorld(this.ball, this.foot.sweep(0, 1), DT, { side: 'A', wall: false }, tuning, []);
      this.foot.commit();
    }

    const c = this.ctx;
    c.fillStyle = '#0d1230';
    c.fillRect(0, 0, W, GROUND);
    c.fillStyle = '#2c8a3c';
    c.fillRect(0, GROUND, W, H - GROUND);
    c.fillStyle = '#eef3ff';
    c.fillRect(0, GROUND, W, 1);
    const sx = (x: number) => Math.round((x - OX) * PPM);
    const sy = (y: number) => Math.round(GROUND - y * PPM);
    const half = (BOOT_SIZE - 1) / 2;
    c.drawImage(
      bootSprite('A', this.foot.vy * 0.03 - this.foot.vx * 0.008),
      sx(this.foot.x) - half,
      sy(this.foot.y) - half,
    );
    c.drawImage(ballSprite(this.ball.angle), sx(this.ball.x) - (BALL_SIZE >> 1), sy(this.ball.y) - (BALL_SIZE >> 1));
  }
}

/** Six small looping demonstrations of the moves, run with the real physics. */
export class Howto {
  private demos: Demo[] = [];

  constructor(root: HTMLElement) {
    for (const move of MOVES) {
      const card = document.createElement('div');
      card.className = 'demo';
      const canvas = document.createElement('canvas');
      const title = document.createElement('b');
      title.textContent = move.title;
      const text = document.createElement('span');
      text.textContent = move.text;
      card.append(canvas, title, text);
      root.append(card);
      this.demos.push(new Demo(move, canvas));
    }
  }

  tick(dt: number): void {
    for (const d of this.demos) d.tick(dt);
  }
}
