import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchClient } from '../src/client/match';
import { Arcade, type ArcadeHost } from '../src/server/arcade';
import { Room } from '../src/server/room';
import { ARENAS, BUMPER_MIN_SPEED, PAD_MIN_SPEED } from '../src/shared/arena';
import { PRESETS } from '../src/shared/config';
import { DT, GOAL_H, tuning as t } from '../src/shared/constants';
import { ARCADE, effectiveTuning, speedLimitScale, windNow } from '../src/shared/effects';
import { collideFoot } from '../src/shared/foot';
import { isGoal, stepWorld } from '../src/shared/physics';
import type { ClientMsg, EventMsg, MatchStateMsg, ServerMsg, Slot } from '../src/shared/protocol';
import { RULES } from '../src/shared/rules';
import { newBall, type SimEvent, type World } from '../src/shared/types';

const run = (b: ReturnType<typeof newBall>, seconds: number, world: World): SimEvent[] => {
  const ev: SimEvent[] = [];
  for (let i = 0; i < seconds / DT; i++) stepWorld(b, null, DT, world, t, ev);
  return ev;
};

describe('arcade physics', () => {
  it('a taller goal lets in a shot that would have hit the board', () => {
    const shot = () => newBall(12, 10.5, -25, 1);
    const low = shot();
    run(low, 0.6, { side: 'A', wall: false });
    expect(isGoal(low, 'A', t)).toBe(false);

    const high = shot();
    run(high, 0.6, { side: 'A', wall: false, goalH: 14 });
    expect(isGoal(high, 'A', t, 14)).toBe(true);
  });

  it('a bumper throws the ball back, and never slowly', () => {
    const arena = ARENAS.pinball;
    const bump = arena.bumpers[0];
    const b = newBall(bump.x + 3, bump.y, -20, 0);
    const ev = run(b, 0.2, { side: 'A', wall: false, arena });
    expect(ev.some((e) => e.type === 'bumper')).toBe(true);
    expect(b.vx).toBeGreaterThan(0);
    expect(ev.find((e) => e.type === 'bumper')).toBeDefined();
    const b2 = newBall(bump.x + 2.2, bump.y, -5, 0);
    const ev2: SimEvent[] = [];
    for (let i = 0; i < 20 && !ev2.length; i++) stepWorld(b2, null, DT, { side: 'A', wall: false, arena }, t, ev2);
    expect(Math.hypot(b2.vx, b2.vy)).toBeGreaterThanOrEqual(BUMPER_MIN_SPEED - 0.5);
  });

  it('the arena is mirrored for side B', () => {
    const arena = ARENAS.pinball;
    const bump = arena.bumpers[0];
    const b = newBall(100 - bump.x - 3, bump.y, 20, 0);
    const ev = run(b, 0.2, { side: 'B', wall: false, arena });
    expect(ev.some((e) => e.type === 'bumper')).toBe(true);
    expect(b.vx).toBeLessThan(0);
  });

  it('a trampoline always sends the ball back up hard', () => {
    const arena = ARENAS.springs;
    const [from, to] = arena.pads[0];
    const b = newBall((from + to) / 2, 2, 0, -3);
    const ev: SimEvent[] = [];
    for (let i = 0; i < 60 && !ev.some((e) => e.type === 'pad'); i++) {
      stepWorld(b, null, DT, { side: 'A', wall: false, arena }, t, ev);
    }
    expect(b.vy).toBeGreaterThanOrEqual(PAD_MIN_SPEED - 0.5);
  });

  it('a ball entering an open portal leaves the other one; a closed portal does nothing', () => {
    const arena = ARENAS.portals;
    const [p, q] = arena.portals!;
    const open = newBall(p.x + 3, p.y, -20, 0);
    const ev = run(open, 0.2, { side: 'A', wall: false, arena, portalsOpen: true });
    expect(ev.some((e) => e.type === 'portal')).toBe(true);
    expect(Math.hypot(open.x - q.x, open.y - q.y)).toBeLessThan(4);

    const shut = newBall(p.x + 3, p.y, -20, 0);
    const ev2 = run(shut, 0.2, { side: 'A', wall: false, arena, portalsOpen: false });
    expect(ev2.some((e) => e.type === 'portal')).toBe(false);
  });

  it('wind pushes a ball in the air and leaves one on the ground alone', () => {
    const air = newBall(25, 10);
    run(air, 0.5, { side: 'A', wall: false, wind: 7 });
    expect(air.vx).toBeGreaterThan(2);
    const ground = newBall(25, t.ballRadius);
    run(ground, 0.5, { side: 'A', wall: false, wind: 7 });
    expect(ground.vx).toBe(0);
  });
});

describe('fireball and stun', () => {
  const swing = { x0: 22, y0: 5, x1: 23.6, y1: 5, vx: 30, vy: 0 };

  it('a charged kick launches a fireball above the normal cap, and it stays above it in flight', () => {
    const b = newBall(25, 5);
    const ev: SimEvent[] = [];
    collideFoot(b, { ...swing, side: 'A', charged: true }, t, ev);
    expect(b.fire).toBe(true);
    expect(ev.some((e) => e.type === 'fire')).toBe(true);
    expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(t.maxShot * ARCADE.fireMult, 5);
    stepWorld(b, null, DT, { side: 'A', wall: false }, t, []);
    expect(Math.hypot(b.vx, b.vy)).toBeGreaterThan(t.maxShot * 1.3);
  });

  it('an uncharged kick is still capped', () => {
    const b = newBall(25, 5);
    collideFoot(b, { ...swing, side: 'A' }, t, []);
    expect(b.fire).toBe(false);
    expect(Math.hypot(b.vx, b.vy)).toBeLessThanOrEqual(t.maxShot + 1e-9);
  });

  it("blocking the opponent's fireball stuns the boot and puts the fire out", () => {
    const b = newBall(26.5, 5, -45, 0);
    b.fire = true;
    b.by = 'B';
    const ev: SimEvent[] = [];
    collideFoot(b, { x0: 25, y0: 5, x1: 25, y1: 5, vx: 0, vy: 0, side: 'A' }, t, ev);
    expect(ev).toContainEqual({ type: 'stun', ms: ARCADE.fireStunMs });
    expect(b.fire).toBe(false);
    expect(b.by).toBe('A');
  });

  it('blocking a shot near the cap stuns briefly; a gentle one or your own ball does not', () => {
    const block = (speed: number, by: 'A' | 'B') => {
      const b = newBall(26.5, 5, -speed, 0);
      b.by = by;
      const ev: SimEvent[] = [];
      collideFoot(b, { x0: 25, y0: 5, x1: 25, y1: 5, vx: 0, vy: 0, side: 'A' }, t, ev);
      return ev.some((e) => e.type === 'stun');
    };
    expect(block(34, 'B')).toBe(true);
    expect(block(15, 'B')).toBe(false);
    expect(block(34, 'A')).toBe(false);
  });
});

describe('effects', () => {
  it('each modifier and power-up bends the tuning it should', () => {
    expect(effectiveTuning(t, 'lowgrav', []).gravity).toBeLessThan(t.gravity);
    expect(effectiveTuning(t, 'bigball', []).ballRadius).toBeGreaterThan(t.ballRadius);
    expect(effectiveTuning(t, 'tinyball', []).ballRadius).toBeLessThan(t.ballRadius);
    expect(effectiveTuning(t, 'icy', []).rollFriction).toBeLessThan(t.rollFriction);
    expect(effectiveTuning(t, 'turbo', []).maxShot).toBeGreaterThan(t.maxShot);
    expect(effectiveTuning(t, null, ['giant']).footRadius).toBeCloseTo(t.footRadius * 1.6);
    expect(effectiveTuning(t, null, ['shrink']).footRadius).toBeCloseTo(t.footRadius * 0.6);
    expect(effectiveTuning(t, null, [])).toEqual(t);
  });

  it('crosswind blows one way then the other', () => {
    expect(windNow('wind', ARCADE.modRunMs - 1000)).toBeGreaterThan(0);
    expect(windNow('wind', 1000)).toBeLessThan(0);
    expect(windNow('turbo', 1000)).toBe(0);
  });

  it('the server allows more speed for a fireball and under Turbo', () => {
    expect(speedLimitScale(null, false)).toBe(1);
    expect(speedLimitScale(null, true)).toBe(ARCADE.fireMult);
    expect(speedLimitScale('turbo', true)).toBeCloseTo(1.3 * ARCADE.fireMult);
  });
});

describe('arcade director', () => {
  function setup(arena: 'pinball' | 'portals' = 'pinball') {
    const events: EventMsg[] = [];
    let extra = false;
    const extraBall = vi.fn(() => (extra = true));
    const host: ArcadeHost = {
      rng: () => 0.5,
      matchMs: RULES.matchMs,
      changed: () => {},
      event: (e) => events.push(e),
      hasExtraBall: () => extra,
      extraBall,
    };
    const a = new Arcade(host, arena);
    /** Advance play time in the same small steps the room uses. */
    const play = (ms: number, golden = false) => {
      for (let left = ms; left > 0; left -= 200) a.advance(Math.min(200, left), golden);
    };
    return { a, events, play, extraBall };
  }

  it('grows the goals every thirty seconds of play, up to a limit, and further in golden goal', () => {
    const { a, play, events } = setup();
    expect(a.state().goalH).toBe(GOAL_H);
    play(30_000);
    expect(a.goalH).toBe(GOAL_H + ARCADE.goalGrowBy);
    expect(events.some((e) => e.kind === 'grow')).toBe(true);
    play(200_000);
    expect(a.goalH).toBe(ARCADE.goalMaxH);
    expect(a.state().growInMs).toBeNull();
    play(200, true);
    expect(a.goalH).toBe(ARCADE.goalGoldenH);
  });

  it('announces a modifier five seconds ahead, runs it for twenty, then clears it', () => {
    const { a, play, events } = setup();
    play(ARCADE.modFirstWarnMs - 400);
    expect(a.state().mod).toBeNull();
    expect(a.state().nextModInMs).toBe(400);
    play(400);
    expect(events.at(-1)?.kind).toBe('mod_soon');
    expect(a.running).toBeNull();
    expect(a.state().mod).toMatchObject({ startsInMs: ARCADE.modWarnMs, leftMs: ARCADE.modRunMs });
    play(ARCADE.modWarnMs);
    expect(a.running).not.toBeNull();
    expect(events.some((e) => e.kind === 'mod')).toBe(true);
    play(ARCADE.modRunMs);
    expect(a.running).toBeNull();
    expect(a.state().mod).toBeNull();
  });

  it('shows a power-up on each half three seconds before it can be collected', () => {
    const { a, play } = setup();
    play(ARCADE.itemFirstMs);
    const items = a.state().items.filter((i) => i.kind !== 'target');
    expect(items.map((i) => i.half).sort()).toEqual(['A', 'B']);
    expect(items[0].liveInMs).toBe(ARCADE.itemWarnMs);
    play(ARCADE.itemWarnMs);
    expect(a.state().items[0].liveInMs).toBe(0);
  });

  it('gives a power-up to the last kicker, once, and only after it is live', () => {
    const { a, play, events } = setup();
    play(ARCADE.itemFirstMs);
    const item = a.state().items.find((i) => i.half === 'A')!;
    a.pickup('A', item.id, 'B');
    expect(events.some((e) => e.kind === 'pickup')).toBe(false);

    play(ARCADE.itemWarnMs);
    a.pickup('B', item.id, 'B');
    expect(events.some((e) => e.kind === 'pickup')).toBe(false);
    a.pickup('A', item.id, 'B');
    a.pickup('A', item.id, 'B');
    const picks = events.filter((e) => e.kind === 'pickup');
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({ side: 'B', item: item.kind });
    expect(a.state().items.some((i) => i.id === item.id)).toBe(false);
  });

  it('a timed power-up acts on the right player and wears off', () => {
    const { a, play } = setup();
    play(ARCADE.itemFirstMs + ARCADE.itemWarnMs);
    // Find a timed one on either half and collect it for A.
    const item = a.state().items.find((i) => i.kind !== 'target')!;
    a.pickup(item.half, item.id, 'A');
    const fx = a.state().effects;
    if (fx.length) {
      expect(fx[0].by).toBe('A');
      play(fx[0].totalMs + 200);
      expect(a.state().effects).toHaveLength(0);
    }
  });

  it('opens the portals for ten seconds in every thirty-five', () => {
    const { a, play } = setup('portals');
    play(1000);
    expect(a.state().portals).toMatchObject({ open: false });
    play(ARCADE.portalCycleMs - ARCADE.portalOpenMs - 1000);
    expect(a.state().portals).toMatchObject({ open: true, inMs: ARCADE.portalOpenMs });
    play(ARCADE.portalOpenMs);
    expect(a.state().portals!.open).toBe(false);
  });

  it('warns of the frenzy, then drops a second ball for the last thirty seconds', () => {
    const { a, play, events, extraBall } = setup();
    play(RULES.matchMs - ARCADE.frenzyMs - ARCADE.frenzyWarnMs);
    expect(events.at(-1)?.kind).toBe('frenzy_soon');
    expect(a.frenzy).toBe(false);
    play(ARCADE.frenzyWarnMs);
    expect(a.frenzy).toBe(true);
    expect(extraBall).toHaveBeenCalledWith(null);
    play(400, true);
    expect(a.frenzy).toBe(false);
  });

  it('never schedules a modifier that would run into the frenzy', () => {
    const { a, play } = setup();
    play(RULES.matchMs - ARCADE.frenzyMs);
    expect(a.state().mod).toBeNull();
    expect(a.state().nextModInMs).toBeNull();
  });
});

describe('arcade room', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(mode: 'arcade' | 'classic' = 'arcade') {
    const sent: { slot: Slot; m: ServerMsg }[] = [];
    const room = new Room('TEST', (slot, m) => sent.push({ slot, m }), { rng: () => 0, rules: { stallMs: 10_000_000 } });
    room.sync(room.add()!.slot);
    room.sync(room.add()!.slot);
    if (mode === 'classic') room.onMessage(0, { type: 'set_config', patch: { preset: 'classic' } });
    // A fixed arena and no keeper or hazards, so these tests see only what they are about.
    else room.onMessage(0, { type: 'set_config', patch: { arena: 'pinball', keeper: 'off', hazards: false } });
    room.onMessage(0, { type: 'ready', ready: true });
    room.onMessage(1, { type: 'ready', ready: true });
    vi.advanceTimersByTime(RULES.countdownMs);
    const state = () => sent.filter((s) => s.slot === 0 && s.m.type === 'match_state').at(-1)!.m as MatchStateMsg;
    const goals = () =>
      sent.filter((s) => s.slot === 0 && s.m.type === 'event' && s.m.kind === 'goal').map((s) => s.m as EventMsg);
    return { room, sent, state, goals };
  }

  it('is the default, and only the creator can switch to Classic', () => {
    const room = new Room('TEST', () => {});
    room.add();
    room.add();
    expect(room.config.preset).toBe('arcade');
    room.onMessage(1, { type: 'set_config', patch: { preset: 'classic' } });
    expect(room.config.preset).toBe('arcade');
    room.onMessage(0, { type: 'set_config', patch: { preset: 'classic' } });
    expect(room.config.preset).toBe('classic');
  });

  it('Classic sends no arcade state and never grows the goals', () => {
    const { state, room } = setup('classic');
    vi.advanceTimersByTime(60_000);
    expect(room.arcade).toBeNull();
    expect(state().arcade).toBeNull();
  });

  it('tells both players what is on the pitch as it changes', () => {
    const { state } = setup();
    expect(state().arcade).toMatchObject({ goalH: GOAL_H, frenzy: false });
    vi.advanceTimersByTime(ARCADE.itemFirstMs + 400);
    expect(state().arcade!.items.length).toBeGreaterThanOrEqual(2);
  });

  it('does not run arcade time while the match is paused', () => {
    const { room } = setup();
    vi.advanceTimersByTime(4000);
    room.onMessage(1, { type: 'away', away: true });
    const at = room.arcade!.playMs;
    vi.advanceTimersByTime(20_000);
    expect(room.arcade!.playMs).toBe(at);
  });

  it('keeps the two balls apart: each has its own owner and sequence', () => {
    const { room } = setup();
    room.spawnExtraBall('B');
    const [main, extra] = room.relays;
    expect(extra.alive).toBe(true);
    expect(extra.owner).toBe('B');
    const before = main.seq;
    room.onMessage(1, { type: 'handoff', ball: 1, seq: extra.seq + 1, y: 5, vx: -20, vy: 0, t: 0 });
    expect(extra.owner).toBe('A');
    expect(main.seq).toBe(before);
    expect(main.owner).toBe('A');
  });

  it('a goal with either ball stops play and kills both', () => {
    const { room } = setup();
    room.spawnExtraBall('B');
    room.onMessage(1, { type: 'goal', ball: 1, seq: room.relays[1].seq, speed: 20, clean: false });
    expect(room.score).toEqual({ A: 1, B: 0 });
    expect(room.relays.map((r) => r.alive)).toEqual([false, false]);
    expect(room.phase).toBe('goal');
  });

  it('goals count double in the final frenzy, and each kickoff then has two balls', () => {
    const { room, goals } = setup();
    vi.advanceTimersByTime(RULES.matchMs - ARCADE.frenzyMs + 400);
    expect(room.arcade!.frenzy).toBe(true);
    expect(room.relays[1].alive).toBe(true);
    const slot = room.players.findIndex((p) => p?.side === room.relay.owner) as Slot;
    room.onMessage(slot, { type: 'goal', seq: room.relay.seq, speed: 20, clean: false });
    expect(room.score.A + room.score.B).toBe(2);
    expect(goals().at(-1)).toMatchObject({ points: 2 });
    vi.advanceTimersByTime(RULES.goalPauseMs);
    expect(room.relays.map((r) => r.alive)).toEqual([true, true]);
  });

  it('accepts a fireball handoff above the normal cap but not an ordinary one', () => {
    const { room } = setup();
    const fast = { type: 'handoff', y: 5, vx: 46, vy: 0, t: 0 } as const;
    room.onMessage(0, { ...fast, seq: room.relay.seq + 1 });
    expect(room.relay.stats.rejected).toBe(1);
    room.onMessage(0, { ...fast, seq: room.relay.seq + 1, fire: true });
    expect(room.relay.stats.rejected).toBe(1);
    expect(room.relay.owner).toBe('B');
  });

  it("passes each player's super meter to the other", () => {
    const { room, sent } = setup();
    room.onMessage(0, { type: 'meter', v: 0.5, ghost: true });
    const got = sent.filter((s) => s.m.type === 'meter');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ slot: 1, m: { side: 'A', v: 0.5, ghost: true } });
  });
});

describe('arcade client', () => {
  function client() {
    const sent: ClientMsg[] = [];
    let now = 0;
    const c = new MatchClient((m) => sent.push(m), { type: 'create' }, () => now, 500);
    const p = { ready: true, connected: true, name: 'P', streak: 0 };
    c.onMessage({ type: 'joined', code: 'TEST', token: 't', you: 0 });
    c.onMessage({
      type: 'room_state',
      code: 'TEST',
      players: [
        { id: 0, seat: 'A1', side: 'A', watch: false, ...p },
        { id: 1, seat: 'B1', side: 'B', watch: false, ...p },
      ],
      host: 0,
      config: PRESETS.arcade,
      team: 1,
      format: 'match',
      bracket: null,
    });
    const state = (over: Partial<NonNullable<MatchStateMsg['arcade']>> = {}): MatchStateMsg => ({
      type: 'match_state',
      phase: 'playing',
      score: { A: 0, B: 0 },
      remainingMs: 180_000,
      golden: false,
      game: 1,
      series: 1,
      seriesScore: { A: 0, B: 0 },
      kickoff: 'A',
      timerMs: 0,
      pauseReason: null,
      arcade: {
        playMs: 0,
        keeper: 'off',
        arena: 'pinball',
        goalH: GOAL_H,
        growInMs: 30_000,
        mod: null,
        nextModInMs: 10_000,
        frenzy: false,
        frenzyInMs: 150_000,
        portals: null,
        items: [],
        effects: [],
        ...over,
      },
    });
    c.onMessage({ ...state(), phase: 'countdown' });
    c.onMessage(state());
    return { c, sent, state, advance: (ms: number) => (now += ms) };
  }

  it('holds two balls at once, each with its own sequence', () => {
    const { c } = client();
    c.onMessage({ type: 'spawn', ball: 0, seq: 1 });
    c.onMessage({ type: 'handoff', ball: 1, seq: 7, y: 5, vx: -10, vy: 0, t: 0 });
    expect(c.balls()).toHaveLength(2);
    c.onMessage({ type: 'take_ball', ball: 1 });
    expect(c.balls()).toHaveLength(1);
    expect(c.seq).toBe(1);
  });

  it('a goal clears every ball except the one in the net', () => {
    const { c, state } = client();
    c.onMessage({ type: 'spawn', ball: 0, seq: 1 });
    c.onMessage({ type: 'handoff', ball: 1, seq: 7, y: 3, vx: -30, vy: 2, t: 0 });
    for (let i = 0; i < 400; i++) c.step(null, []);
    c.onMessage({ ...state(), phase: 'goal' });
    expect(c.balls().map((b) => b.id)).toEqual([1]);
  });

  it('a fireball power-up fills the meter; a ghost one arms the next shot', () => {
    const { c } = client();
    c.onMessage({ type: 'event', kind: 'pickup', side: 'B', item: 'fireball' });
    expect(c.meter).toBe(0);
    c.onMessage({ type: 'event', kind: 'pickup', side: 'A', item: 'fireball' });
    expect(c.meter).toBe(1);
    c.onMessage({ type: 'event', kind: 'pickup', side: 'A', item: 'ghost' });
    expect(c.ghostReady).toBe(true);
  });

  it('marks its next shot as a ghost and gives no warning of it', () => {
    const { c, sent, advance } = client();
    c.onMessage({ type: 'spawn', seq: 1 });
    c.onMessage({ type: 'event', kind: 'pickup', side: 'A', item: 'ghost' });
    advance(500);
    c.tick();
    expect(sent.some((m) => m.type === 'ball_preview')).toBe(false);
    c.ball!.vx = 30;
    for (let i = 0; i < 200 && c.ball; i++) c.step(null, []);
    expect(sent.find((m) => m.type === 'handoff')).toMatchObject({ ghost: true });
    expect(c.ghostReady).toBe(false);
  });

  it('claims a live item its ball touches, naming the last kicker', () => {
    const { c, sent, state } = client();
    c.onMessage({ type: 'spawn', seq: 1 });
    const b = c.ball!;
    c.onMessage(state({ items: [{ id: 9, half: 'A', kind: 'giant', lx: b.x, y: b.y - 1, liveInMs: 0, leftMs: 20_000 }] }));
    b.by = 'B';
    for (let i = 0; i < 30; i++) c.step(null, []);
    const picks = sent.filter((m) => m.type === 'pickup');
    expect(picks).toEqual([{ type: 'pickup', id: 9, by: 'B' }]);
  });

  it('leaves an item alone until it is live', () => {
    const { c, sent, state } = client();
    c.onMessage({ type: 'spawn', seq: 1 });
    const b = c.ball!;
    c.onMessage(state({ items: [{ id: 9, half: 'A', kind: 'giant', lx: b.x, y: b.y - 1, liveInMs: 60_000, leftMs: 80_000 }] }));
    for (let i = 0; i < 30; i++) c.step(null, []);
    expect(sent.some((m) => m.type === 'pickup')).toBe(false);
  });

  it('counts timers down only during play', () => {
    const { c, state, advance } = client();
    c.onMessage(state({ mod: { kind: 'lowgrav', startsInMs: 5000, leftMs: 20_000 } }));
    advance(2000);
    expect(c.modNow()).toMatchObject({ running: false, secs: 3 });
    advance(4000);
    expect(c.modNow()).toMatchObject({ running: true, secs: 19 });
    expect(c.tuningNow().gravity).toBeLessThan(t.gravity);
    c.onMessage({ ...state({ mod: { kind: 'lowgrav', startsInMs: 0, leftMs: 19_000 } }), phase: 'paused' });
    advance(10_000);
    expect(c.modNow()).toMatchObject({ running: true, secs: 19 });
  });

  it('a frozen or stunned boot cannot touch the ball', () => {
    const { c, state } = client();
    c.onMessage({ type: 'spawn', seq: 1 });
    c.onMessage(state({ effects: [{ kind: 'freeze', side: 'A', by: 'B', leftMs: 2000, totalMs: 2000 }] }));
    const b = c.ball!;
    const ev: SimEvent[] = [];
    c.step({ x0: b.x - 3, y0: b.y, x1: b.x + 3, y1: b.y, vx: 30, vy: 0 }, ev);
    expect(ev.some((e) => e.type === 'kick')).toBe(false);
    expect(c.frozen).toBe(true);
  });

  it('a big-goal power-up makes my own goal taller', () => {
    const { c, state } = client();
    expect(c.goalH()).toBe(GOAL_H);
    c.onMessage(state({ effects: [{ kind: 'biggoal', side: 'A', by: 'B', leftMs: 5000, totalMs: 10_000 }] }));
    expect(c.goalH()).toBe(GOAL_H * ARCADE.bigGoalMult);
  });
});
