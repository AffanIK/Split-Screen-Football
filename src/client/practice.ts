import { DT, tuning } from '../shared/constants';
import type { FootSweep } from '../shared/foot';
import { isGoal, stepWorld } from '../shared/physics';
import { newBall, type Ball, type SimEvent, type World } from '../shared/types';

const RESPAWN_S = 1.2;

/** Solo kick-about on side A with a wall at the halfway line. */
export class Practice {
  readonly world: World = { side: 'A', wall: true };
  ball: Ball = newBall(30, 12);
  stats = { lastShot: 0, bestShot: 0, juggle: 0, bestJuggle: 0, goals: 0 };
  private wallHit = false;
  private time = 0;
  private lastTouch = -1;
  private respawn = 0;

  step(foot: FootSweep | null, ev: SimEvent[]): void {
    const from = ev.length;
    this.time += DT;
    stepWorld(this.ball, foot, DT, this.world, tuning, ev);

    const s = this.stats;
    for (let i = from; i < ev.length; i++) {
      const e = ev[i];
      if (e.type === 'kick') {
        this.wallHit = false;
        if (e.power >= 6) {
          s.lastShot = e.speed;
          s.bestShot = Math.max(s.bestShot, e.speed);
        }
        // A juggle is a touch while the ball is in the air; one swipe counts once.
        if (e.air && this.time - this.lastTouch > 0.15) {
          s.juggle++;
          s.bestJuggle = Math.max(s.bestJuggle, s.juggle);
        }
        this.lastTouch = this.time;
      } else if (e.type === 'bounce') {
        if (e.kind === 'wall') this.wallHit = true;
        if (e.kind === 'ground') s.juggle = 0;
      }
    }
    if (this.ball.onGround) s.juggle = 0;

    if (this.respawn > 0) {
      this.respawn -= DT;
      if (this.respawn <= 0) {
        this.ball = newBall(30, 12);
        this.wallHit = false;
      }
    } else if (isGoal(this.ball, 'A', tuning)) {
      // Only a shot that came back off the wall counts.
      if (this.wallHit) {
        s.goals++;
        ev.push({ type: 'goal' });
      }
      this.respawn = RESPAWN_S;
    }
  }
}
