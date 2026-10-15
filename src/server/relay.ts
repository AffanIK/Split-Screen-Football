import { RESEND_MS, ROOF_Y, tuning } from '../shared/constants';
import type { HandoffMsg, PreviewMsg, ServerMsg } from '../shared/protocol';
import { other, type Side } from '../shared/types';

export interface RelayOptions {
  resendMs?: number;
  maxSpeed?: number;
}

/**
 * Keeps the one fact both screens must agree on about a ball: who owns it,
 * and the latest sequence number. It never simulates the ball; it relays each
 * handoff until the receiver confirms it. A match has one relay per ball.
 */
export class BallRelay {
  owner: Side = 'A';
  seq = 0;
  /** False until spawned, and again once the ball is dead. */
  alive = false;
  stats = { resends: 0, rejected: 0 };
  onOwnerChange: (() => void) | null = null;
  /** How far above the normal cap this handoff may be (fireball, Turbo). */
  speedScale: (m: HandoffMsg) => number = () => 1;
  private pending: { to: Side; msg: HandoffMsg; timer: ReturnType<typeof setInterval> } | null = null;
  private resendMs: number;
  private maxSpeed: number;

  constructor(
    private send: (to: Side, m: ServerMsg) => void,
    opts: RelayOptions = {},
    readonly id = 0,
  ) {
    this.resendMs = opts.resendMs ?? RESEND_MS;
    this.maxSpeed = opts.maxSpeed ?? tuning.maxShot;
  }

  /** Give a fresh ball to one side. The new sequence number makes any message about the old ball stale. */
  spawn(side: Side): void {
    this.kill();
    this.alive = true;
    this.owner = side;
    this.send(side, { type: 'spawn', ball: this.id, seq: this.seq });
    this.onOwnerChange?.();
  }

  /** Take the ball off the pitch. */
  take(): void {
    const from = this.owner;
    this.kill();
    this.send(from, { type: 'take_ball', ball: this.id });
  }

  /** The current ball is dead: nothing more about it will be accepted. */
  kill(): void {
    this.clearPending();
    this.alive = false;
    this.seq++;
  }

  /** Repeat an unconfirmed handoff to a receiver who has just come back. */
  resendTo(side: Side): boolean {
    if (!this.pending || this.pending.to !== side) return false;
    this.send(side, this.pending.msg);
    return true;
  }

  onHandoff(side: Side, m: HandoffMsg): void {
    if (!this.alive) return;
    if (side === this.owner && m.seq === this.seq + 1) {
      if (!this.valid(m)) {
        this.stats.rejected++;
        this.spawn(side);
        return;
      }
      // A new handoff from the receiver of the last one also confirms that one.
      this.clearPending();
      this.seq = m.seq;
      this.owner = other(side);
      this.send(side, { type: 'handoff_ok', ball: this.id, seq: m.seq });
      const to = this.owner;
      const msg: HandoffMsg = {
        type: 'handoff',
        ball: this.id,
        seq: m.seq,
        y: m.y,
        vx: m.vx,
        vy: m.vy,
        t: m.t,
        by: m.by === 'A' || m.by === 'B' ? m.by : null,
        fire: !!m.fire,
        ghost: !!m.ghost,
      };
      this.send(to, msg);
      const timer = setInterval(() => {
        this.stats.resends++;
        this.send(to, msg);
      }, this.resendMs);
      this.pending = { to, msg, timer };
      this.onOwnerChange?.();
    } else if (side !== this.owner && m.seq === this.seq) {
      // A repeat of the handoff already accepted; the sender missed the confirmation.
      this.send(side, { type: 'handoff_ok', ball: this.id, seq: m.seq });
    } else if (m.seq > this.seq) {
      this.send(side, { type: 'drop_ball', ball: this.id, seq: this.seq });
    }
    // Anything older is a stale repeat and is ignored.
  }

  onAck(side: Side, seq: number): void {
    if (this.pending && this.pending.to === side && this.pending.msg.seq === seq) this.clearPending();
  }

  onPreview(side: Side, m: PreviewMsg): void {
    if (this.alive && side === this.owner) this.send(other(side), { ...m, ball: this.id });
  }

  close(): void {
    this.clearPending();
  }

  private valid(m: HandoffMsg): boolean {
    if (![m.y, m.vx, m.vy].every(Number.isFinite)) return false;
    if (Math.hypot(m.vx, m.vy) > this.maxSpeed * this.speedScale(m) * 1.02 + 0.5) return false;
    return m.y >= 0 && m.y <= ROOF_Y;
  }

  private clearPending(): void {
    if (!this.pending) return;
    clearInterval(this.pending.timer);
    this.pending = null;
  }
}
