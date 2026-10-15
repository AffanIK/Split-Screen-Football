import { describe, expect, it } from 'vitest';
import { MatchClient } from '../src/client/match';
import { DT, HALF_X, tuning as t } from '../src/shared/constants';
import { entryBall, shouldHandOff } from '../src/shared/handoff';
import { stepWorld } from '../src/shared/physics';
import { PRESETS } from '../src/shared/config';
import type { ClientMsg, MatchStateMsg, Phase } from '../src/shared/protocol';
import { newBall, type SimEvent } from '../src/shared/types';

const r = t.ballRadius;

describe('handoff rule', () => {
  it('waits until the whole ball is past the line and moving away', () => {
    expect(shouldHandOff(newBall(HALF_X + r - 0.01, 5, 10), 'A', r)).toBe(false);
    expect(shouldHandOff(newBall(HALF_X + r + 0.01, 5, 10), 'A', r)).toBe(true);
    expect(shouldHandOff(newBall(HALF_X + r + 0.01, 5, -10), 'A', r)).toBe(false);
    expect(shouldHandOff(newBall(HALF_X - r - 0.01, 5, -10), 'B', r)).toBe(true);
    expect(shouldHandOff(newBall(HALF_X - r - 0.01, 5, 10), 'B', r)).toBe(false);
  });

  it('does not fire for a ball bouncing on the line', () => {
    const b = newBall(HALF_X, 6, 0, 0);
    const ev: SimEvent[] = [];
    for (let i = 0; i < 3 / DT; i++) {
      stepWorld(b, null, DT, { side: 'A', wall: false }, t, ev);
      expect(shouldHandOff(b, 'A', r)).toBe(false);
      expect(shouldHandOff(b, 'B', r)).toBe(false);
    }
  });

  it('hands off at any height', () => {
    expect(shouldHandOff(newBall(HALF_X + 2, 23, 5, 10), 'A', r)).toBe(true);
  });

  it('enters just off the inner edge, same height and velocity, and is not handed straight back', () => {
    const b = entryBall('B', { y: 7, vx: 12, vy: -3 }, r);
    expect(b.x).toBeCloseTo(HALF_X - r);
    expect(b).toMatchObject({ y: 7, vx: 12, vy: -3 });
    expect(shouldHandOff(b, 'B', r)).toBe(false);
  });
});

describe('match client', () => {
  const state = (phase: Phase): MatchStateMsg => ({
    type: 'match_state',
    phase,
    score: { A: 0, B: 0 },
    remainingMs: 180_000,
    golden: false,
    game: 1,
    series: 1,
    seriesScore: { A: 0, B: 0 },
    kickoff: 'A',
    timerMs: 0,
    pauseReason: null,
  });

  function client() {
    const sent: ClientMsg[] = [];
    let now = 0;
    const c = new MatchClient((m) => sent.push(m), { type: 'create' }, () => now, 500);
    const player = { ready: true, connected: true, name: 'P', streak: 0 };
    c.onMessage({ type: 'joined', code: 'TEST', token: 't', you: 0 });
    c.onMessage({
      type: 'room_state',
      code: 'TEST',
      players: [
        { id: 0, seat: 'A1', side: 'A', watch: false, ...player },
        { id: 1, seat: 'B1', side: 'B', watch: false, ...player },
      ],
      host: 0,
      config: PRESETS.classic,
      team: 1,
      format: 'match',
      bracket: null,
    });
    c.onMessage(state('countdown'));
    c.onMessage(state('playing'));
    return { c, sent, advance: (ms: number) => (now += ms) };
  }

  it('asks to create or join on connecting, and rejoins with its token after a drop', () => {
    const sent: ClientMsg[] = [];
    const c = new MatchClient((m) => sent.push(m), { type: 'join', code: 'KXQT' });
    c.open();
    expect(sent[0]).toEqual({ type: 'join_room', code: 'KXQT', token: undefined });
    c.onMessage({ type: 'joined', code: 'KXQT', token: 'abc', you: 1 });
    c.open();
    expect(sent[1]).toEqual({ type: 'join_room', code: 'KXQT', token: 'abc' });
  });

  it('reports a goal once when its ball crosses its own goal line', () => {
    const { c, sent } = client();
    c.onMessage({ type: 'handoff', seq: 1, y: 3, vx: -30, vy: 2, t: 0 });
    for (let i = 0; i < 400; i++) c.step(null, []);
    const goals = sent.filter((m) => m.type === 'goal');
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ seq: 1, clean: true });
    expect((goals[0] as { speed: number }).speed).toBeGreaterThan(29);
  });

  it('freezes the ball while the match is paused', () => {
    const { c } = client();
    c.onMessage({ type: 'spawn', seq: 1 });
    c.onMessage(state('paused'));
    const y = c.ball!.y;
    for (let i = 0; i < 50; i++) c.step(null, []);
    expect(c.ball!.y).toBe(y);
  });

  it('counts a save when it touches a shot that was going in', () => {
    const { c, sent } = client();
    c.onMessage({ type: 'handoff', seq: 1, y: 3, vx: -30, vy: 2, t: 0 });
    const b = c.ball!;
    c.step({ x0: b.x - 1.2, y0: b.y, x1: b.x - 1.2, y1: b.y, vx: 0, vy: 0 }, []);
    expect(c.mine.saves).toBe(1);
    expect(sent.some((m) => m.type === 'callout' && m.kind === 'save')).toBe(true);
  });

  it('counts a fast handoff as a shot and remembers the fastest', () => {
    const { c } = client();
    c.onMessage({ type: 'spawn', seq: 1 });
    c.ball!.vx = 30;
    for (let i = 0; i < 200 && c.ball; i++) c.step(null, []);
    expect(c.mine.shots).toBe(1);
    expect(c.mine.fastest).toBeGreaterThan(25);
  });

  it('gives up its ball when the referee takes it', () => {
    const { c } = client();
    c.onMessage({ type: 'spawn', seq: 1 });
    c.onMessage({ type: 'take_ball' });
    expect(c.ball).toBeNull();
  });

  it('stops simulating once it hands off, and resends until the server confirms', () => {
    const { c, sent, advance } = client();
    c.onMessage({ type: 'spawn', seq: 0 });
    c.ball!.vx = 30;
    for (let i = 0; i < 200 && c.ball; i++) c.step(null, []);
    expect(c.ball).toBeNull();
    expect(c.ghost).not.toBeNull();
    const handoffs = () => sent.filter((m) => m.type === 'handoff');
    expect(handoffs()).toHaveLength(1);
    expect(handoffs()[0]).toMatchObject({ seq: 1 });

    advance(600);
    c.tick();
    expect(handoffs()).toHaveLength(2);

    c.onMessage({ type: 'handoff_ok', seq: 1 });
    advance(600);
    c.tick();
    expect(handoffs()).toHaveLength(2);
  });

  it('confirms a repeated handoff without creating a second ball', () => {
    const { c, sent } = client();
    const msg = { type: 'handoff', seq: 1, y: 5, vx: -10, vy: 0, t: 0 } as const;
    c.onMessage(msg);
    const first = c.ball;
    c.onMessage(msg);
    expect(c.ball).toBe(first);
    expect(c.stats.in).toBe(1);
    expect(c.stats.dup).toBe(1);
    expect(sent.filter((m) => m.type === 'handoff_ack')).toHaveLength(2);
  });
});
