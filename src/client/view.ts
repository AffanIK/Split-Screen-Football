import { HALF_X } from '../shared/constants';
import type { Side } from '../shared/types';
import { BUF_H, BUF_W, GROUND_PY, PPM } from './gfx/pixel';

/**
 * Fits the 640x360 game buffer into the window as large as it will go,
 * centred, and converts pointer positions back into metres.
 */
export class View {
  /** Device pixels per buffer pixel. */
  scale = 1;
  /** Top-left of the game rectangle, in device pixels. */
  offX = 0;
  offY = 0;
  dpr = 1;
  /** World x at the left edge of this screen. */
  x0 = 0;
  /** Watchers see both halves side by side, so the picture is twice as wide. */
  private wide = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setSide(side: Side): void {
    this.x0 = side === 'A' ? 0 : HALF_X;
  }

  setWide(wide: boolean): void {
    if (wide === this.wide) return;
    this.wide = wide;
    this.resize();
  }

  resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.round(window.innerWidth * this.dpr);
    const h = Math.round(window.innerHeight * this.dpr);
    this.canvas.width = w;
    this.canvas.height = h;
    // Fill the window. A whole-number scale would keep every pixel the same
    // size but leaves a wide border on most laptop screens.
    const bw = BUF_W * (this.wide ? 2 : 1);
    this.scale = Math.min(w / bw, h / BUF_H);
    this.offX = Math.floor((w - bw * this.scale) / 2);
    this.offY = Math.floor((h - BUF_H * this.scale) / 2);

    // The DOM layer (menus, scoreboard) sits exactly over the game rectangle
    // and sizes its text in game pixels.
    const css = document.documentElement.style;
    css.setProperty('--px', `${this.scale / this.dpr}px`);
    css.setProperty('--gx', `${this.offX / this.dpr}px`);
    css.setProperty('--gy', `${this.offY / this.dpr}px`);
    css.setProperty('--gw', `${(bw * this.scale) / this.dpr}px`);
    css.setProperty('--gh', `${(BUF_H * this.scale) / this.dpr}px`);
  }

  /** CSS pixels per metre, for turning mouse movement into foot movement. */
  get cssPerMetre(): number {
    return (this.scale * PPM) / this.dpr;
  }

  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const bx = (clientX * this.dpr - this.offX) / this.scale;
    const by = (clientY * this.dpr - this.offY) / this.scale;
    return { x: this.x0 + bx / PPM, y: (GROUND_PY - by) / PPM };
  }

  /** Copy the finished buffers to the screen, left to right. Shake is in buffer pixels. */
  present(ctx: CanvasRenderingContext2D, buffers: HTMLCanvasElement[], shakeX = 0, shakeY = 0): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    buffers.forEach((buffer, i) => {
      ctx.drawImage(
        buffer,
        this.offX + (i * BUF_W + shakeX) * this.scale,
        this.offY + shakeY * this.scale,
        BUF_W * this.scale,
        BUF_H * this.scale,
      );
    });
  }
}
