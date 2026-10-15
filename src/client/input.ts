import { ROOF_Y, VIEW_W } from '../shared/constants';
import type { View } from './view';

/**
 * Turns pointer movement into a foot position in metres. With pointer lock the
 * foot moves by relative deltas; without it the foot follows the pointer.
 * Mouse buttons are never read: clicks do nothing in play.
 */
export class Input {
  locked = false;
  onLockChange: ((locked: boolean) => void) | null = null;
  /** The foot cannot go above the ceiling, which some arenas lower. */
  maxY = ROOF_Y;
  private dx = 0;
  private dy = 0;
  private abs: { x: number; y: number } | null = null;
  private jumped = true;

  constructor(
    private canvas: HTMLCanvasElement,
    private view: View,
  ) {
    canvas.addEventListener('pointermove', (e) => {
      if (this.locked) {
        this.dx += e.movementX;
        this.dy += e.movementY;
      } else {
        this.abs = { x: e.clientX, y: e.clientY };
      }
    });
    canvas.addEventListener('pointerenter', () => (this.jumped = true));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      this.dx = this.dy = 0;
      this.abs = null;
      this.jumped = true;
      this.onLockChange?.(this.locked);
    });
  }

  /** Browsers may refuse without a recent click; play then carries on in follow mode. */
  requestLock(): void {
    if (this.locked) return;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {
      /* not available */
    }
  }

  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  /**
   * New foot position for this frame. `jump` means the pointer reappeared
   * somewhere else, so the foot should move there without sweeping the gap.
   */
  read(foot: { x: number; y: number }, sensitivity: number): { x: number; y: number; jump: boolean } {
    let { x, y } = foot;
    let jump = false;
    if (this.locked) {
      x += (this.dx / this.view.cssPerMetre) * sensitivity;
      y -= (this.dy / this.view.cssPerMetre) * sensitivity;
      this.dx = this.dy = 0;
    } else if (this.abs) {
      ({ x, y } = this.view.toWorld(this.abs.x, this.abs.y));
      jump = this.jumped;
      this.jumped = false;
    }
    x = Math.min(this.view.x0 + VIEW_W, Math.max(this.view.x0, x));
    y = Math.min(this.maxY, Math.max(0, y));
    return { x, y, jump };
  }
}
