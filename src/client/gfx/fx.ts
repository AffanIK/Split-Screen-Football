import { BUF_W, GROUND_PY } from './pixel';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Downward pull in px/s². */
  g: number;
  life: number;
  size: number;
  colour: string;
  /** Confetti flutters from side to side. */
  flutter: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Small square particles, in buffer pixels. */
export class Fx {
  private parts: Particle[] = [];

  private add(p: Omit<Particle, 'flutter'> & { flutter?: number }): void {
    if (this.parts.length < 600) this.parts.push({ flutter: 0, ...p });
  }

  /** Tufts kicked up where the ball lands. */
  grass(x: number, strength: number): void {
    const n = Math.round(3 + strength * 7);
    for (let i = 0; i < n; i++) {
      this.add({
        x,
        y: GROUND_PY - 1,
        vx: rand(-40, 40) * (0.5 + strength),
        vy: rand(-90, -30) * (0.5 + strength),
        g: 320,
        life: rand(0.25, 0.5),
        size: Math.random() < 0.3 ? 2 : 1,
        colour: Math.random() < 0.5 ? '#5fd070' : '#2c8a3c',
      });
    }
  }

  /** Sparks off the woodwork, the roof or a wall. */
  sparks(x: number, y: number, colour = '#fff3b0'): void {
    for (let i = 0; i < 10; i++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(40, 130);
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, g: 200, life: rand(0.15, 0.35), size: 1, colour });
    }
  }

  /** A puff where the foot strikes the ball. */
  impact(x: number, y: number, dx: number, dy: number, power: number): void {
    const n = Math.round(2 + power * 8);
    for (let i = 0; i < n; i++) {
      this.add({
        x,
        y,
        vx: dx * rand(30, 120) + rand(-30, 30),
        vy: dy * rand(30, 120) + rand(-30, 30),
        g: 0,
        life: rand(0.1, 0.25),
        size: power > 0.7 && Math.random() < 0.4 ? 2 : 1,
        colour: power > 0.85 ? '#ffd23f' : '#ffffff',
      });
    }
  }

  /** Flames trailing a fireball; call every frame it is on screen. */
  flame(x: number, y: number): void {
    for (let i = 0; i < 3; i++) {
      this.add({
        x: x + rand(-4, 4),
        y: y + rand(-4, 4),
        vx: rand(-20, 20),
        vy: rand(-50, -10),
        g: -40,
        life: rand(0.15, 0.4),
        size: Math.random() < 0.5 ? 3 : 2,
        colour: ['#ffd23f', '#ff8a2a', '#e8501e', '#ffffff'][Math.floor(Math.random() * 4)],
      });
    }
  }

  /** A ring of sparkles: a power-up collected, a portal used, a bumper hit. */
  burst(x: number, y: number, colour: string, n = 16): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const s = rand(60, 140);
      this.add({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        g: 60,
        life: rand(0.25, 0.5),
        size: 2,
        colour: i % 3 === 0 ? '#ffffff' : colour,
      });
    }
  }

  /** Streaks blown across the screen; `dir` is +1 or -1. Call every frame the wind blows. */
  wind(dir: number, dt: number): void {
    if (Math.random() > dt * 40) return;
    this.add({
      x: dir > 0 ? -6 : BUF_W + 6,
      y: rand(20, GROUND_PY - 20),
      vx: dir * rand(260, 420),
      vy: rand(-8, 8),
      g: 0,
      life: 2.4,
      size: Math.random() < 0.3 ? 3 : 2,
      colour: 'rgba(220,232,255,0.55)',
    });
  }

  confetti(colours: string[]): void {
    for (let i = 0; i < 140; i++) {
      this.add({
        x: rand(0, BUF_W),
        y: rand(-60, 10),
        vx: rand(-15, 15),
        vy: rand(30, 80),
        g: 20,
        life: rand(1.6, 3),
        size: 2,
        colour: colours[i % colours.length],
        flutter: rand(3, 8),
      });
    }
  }

  draw(ctx: CanvasRenderingContext2D, dt: number): void {
    for (const p of this.parts) {
      p.life -= dt;
      p.vy += p.g * dt;
      p.x += (p.vx + (p.flutter ? Math.sin(p.life * p.flutter) * 30 : 0)) * dt;
      p.y += p.vy * dt;
      ctx.fillStyle = p.colour;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    this.parts = this.parts.filter((p) => p.life > 0 && p.y < GROUND_PY + 30);
  }
}
