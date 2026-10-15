import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Arcade, type ArcadeHost, type ArcadeRules } from '../src/server/arcade';
import { Room } from '../src/server/room';
import { ARENAS, ARCADE_ARENAS, moverY, spotIsFree } from '../src/shared/arena';
import { EMOTE_GAP_MS, PRESETS, cleanName, describeConfig, patchConfig, usesArcade } from '../src/shared/config';
import { DT, GOAL_H, tuning as t } from '../src/shared/constants';
import { ARCADE, isHazard } from '../src/shared/effects';
import { KEEPER_R, KEEPER_X, newKeeper, stepKeeper } from '../src/shared/keeper';
import { stepWorld } from '../src/shared/physics';
import type { EventMsg, MatchStateMsg, ServerMsg, Slot } from '../src/shared/protocol';
import { RULES } from '../src/shared/rules';
import { newBall, type SimEvent, type World } from '../src/shared/types';

const run = (b: ReturnType<typeof newBall>, seconds: number, world: World): SimEvent[] => {
  const ev: SimEvent[] = [];
  for (let i = 0; i < seconds / DT; i++) stepWorld(b, null, DT, world, t, ev);
  return ev;
};

describe('match rules', () => {
  it('a preset replaces every rule except the series length', () => {
    const custom = patchConfig({ ...PRESETS.arcade, series: 3 }, { preset: 'classic' });
    expect(custom).toEqual({ ...PRESETS.classic, series: 3 });
  });

  it('changing one rule by hand makes the preset custom', () => {
    const c = patchConfig(PRESETS.arcade, { keeper: 'hard' });
    expect(c).toMatchObject({ preset: 'custom', keeper: 'hard', powerups: true });
    // Asking for what is already set changes nothing.
    expect(patchConfig(PRESETS.arcade, { keeper: 'normal' }).preset).toBe('arcade');
  });

  it('ignores choices that are not on offer', () => {
    const c = patchConfig(PRESETS.arcade, {
      minutes: 99,
      goals: -1,
      arena: 'moon' as never,
      keeper: 'god' as never,
      powerups: 'yes' as never,
    });
    expect(c).toEqual(PRESETS.arcade);
  });

  it('Classic needs none of the arcade machinery; any one switch brings it in', () => {
    expect(usesArcade(PRESETS.classic)).toBe(false);
    expect(usesArcade(patchConfig(PRESETS.classic, { keeper: 'easy' }))).toBe(true);
    expect(usesArcade(patchConfig(PRESETS.classic, { arena: 'windmill' }))).toBe(true);
  });

  it('describes itself in one line', () => {
    expect(describeConfig(PRESETS.arcade)).toBe('ARCADE / 3 MIN / FIRST TO 5 / RANDOM ARENA / KEEPER NORMAL');
  });

  it('cleans player names', () => {
    expect(cleanName('  sam<script>  ')).toBe('SAMSCRIPT');
    expect(cleanName('a very long name indeed')).toBe('A VERY LON');
    expect(cleanName('')).toBe('PLAYER');
    expect(cleanName(undefined)).toBe('PLAYER');
  });
});

describe('rules in the room', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(patch: Parameters<typeof patchConfig>[1] = {}) {
    const sent: { slot: Slot; m: ServerMsg }[] = [];
    const room = new Room('TEST', (slot, m) => sent.push({ slot, m }), { rng: () => 0, rules: { stallMs: 10_000_000 } });
    room.sync(room.add({ name: 'sam', streak: 3 })!.slot);
    room.sync(room.add({ name: 'alex!!' })!.slot);
    room.onMessage(0, { type: 'set_config', patch });
    const start = () => {
      room.onMessage(0, { type: 'ready', ready: true });
      room.onMessage(1, { type: 'ready', ready: true });
      vi.advanceTimersByTime(RULES.countdownMs);
    };
    const state = () => sent.filter((s) => s.slot === 0 && s.m.type === 'match_state').at(-1)!.m as MatchStateMsg;
    const events = () => sent.filter((s) => s.slot === 0 && s.m.type === 'event').map((s) => s.m as EventMsg);
    return { room, sent, start, state, events };
  }

  it('shows each player the other one’s cleaned name and streak', () => {
    const { room } = setup();
    expect(room.players.map((p) => p!.name)).toEqual(['SAM', 'ALEX']);
    expect(room.players[0]!.streak).toBe(3);
  });

  it('uses the chosen match length and goal target', () => {
    const { room, start, state } = setup({ minutes: 1, goals: 3 });
    start();
    expect(state().remainingMs).toBe(60_000);
    for (let i = 0; i < 3; i++) {
      const slot = room.players.findIndex((p) => p?.side === room.relay.owner) as Slot;
      room.onMessage(slot, { type: 'goal', seq: room.relay.seq, speed: 10, clean: false });
      vi.advanceTimersByTime(RULES.goalPauseMs);
    }
    expect(room.phase).toBe('full_time');
  });

  it('plays in the arena that was picked, or a random one', () => {
    const picked = setup({ arena: 'windmill' });
    picked.start();
    expect(picked.state().arcade!.arena).toBe('windmill');
    const random = setup();
    random.start();
    expect(ARCADE_ARENAS).toContain(random.state().arcade!.arena);
  });

  it('each switch really turns its feature off', () => {
    const { start, state, events } = setup({
      arena: 'pinball',
      powerups: false,
      modifiers: false,
      hazards: false,
      growing: false,
      frenzy: false,
    });
    start();
    vi.advanceTimersByTime(RULES.matchMs - 1000);
    const a = state().arcade!;
    expect(a.items).toHaveLength(0);
    expect(a.goalH).toBe(GOAL_H);
    expect(a.frenzy).toBe(false);
    expect(a.frenzyInMs).toBeNull();
    expect(a.nextModInMs).toBeNull();
    expect(events().some((e) => ['mod', 'mod_soon', 'grow', 'frenzy', 'pickup'].includes(e.kind))).toBe(false);
  });

  it('the rules cannot be changed once the match has started', () => {
    const { room, start } = setup();
    start();
    room.onMessage(0, { type: 'set_config', patch: { goals: 10 } });
    expect(room.config.goals).toBe(5);
  });

  it('relays an emote to both players, but only one every two seconds', () => {
    const { room, sent } = setup();
    const emotes = () => sent.filter((s) => s.m.type === 'emote');
    room.onMessage(1, { type: 'emote', id: 2 });
    room.onMessage(1, { type: 'emote', id: 3 });
    expect(emotes()).toHaveLength(2);
    expect(emotes()[0].m).toEqual({ type: 'emote', side: 'B', name: 'ALEX', id: 2 });
    vi.advanceTimersByTime(EMOTE_GAP_MS);
    room.onMessage(1, { type: 'emote', id: 3 });
    room.onMessage(1, { type: 'emote', id: 99 });
    expect(emotes()).toHaveLength(4);
  });
});

describe('goalkeeper bot', () => {
  const settle = (k: ReturnType<typeof newKeeper>, ball: ReturnType<typeof newBall>, level: 'easy' | 'hard', s = 1) => {
    for (let i = 0; i < s / DT; i++) stepKeeper(k, [ball], 'A', level, GOAL_H, t, DT);
  };

  it('moves to where the shot will cross its rail', () => {
    const k = newKeeper();
    const shot = newBall(20, 6, -25, 0);
    const time = (20 - KEEPER_X) / 25;
    const expected = 6 - 0.5 * t.gravity * time * time;
    settle(k, shot, 'hard', 1.5);
    expect(k.y).toBeCloseTo(expected, 1);
  });

  it('never moves faster than its level allows, and Easy is slower than Hard', () => {
    const fastest = (level: 'easy' | 'hard') => {
      const k = newKeeper();
      let top = 0;
      const shot = newBall(40, 7, -30, 12);
      for (let i = 0; i < 60; i++) {
        stepKeeper(k, [shot], 'A', level, GOAL_H, t, DT);
        top = Math.max(top, Math.abs(k.vy));
      }
      return top;
    };
    expect(fastest('easy')).toBeLessThan(fastest('hard'));
    expect(fastest('hard')).toBeLessThanOrEqual(16 + 1e-6);
  });

  it('stays inside its goal and ignores a ball going away', () => {
    const k = newKeeper();
    settle(k, newBall(40, 20, -25, 0), 'hard');
    expect(k.y).toBeLessThanOrEqual(GOAL_H);
    const rest = newKeeper();
    settle(rest, newBall(20, 20, 25, 0), 'hard');
    expect(rest.y).toBeCloseTo(GOAL_H * 0.4, 1);
  });

  it('guards the mirrored goal on side B', () => {
    const k = newKeeper();
    for (let i = 0; i < 1.5 / DT; i++) stepKeeper(k, [newBall(80, 7, 25, 0)], 'B', 'hard', GOAL_H, t, DT);
    expect(k.y).toBeGreaterThan(4);
  });

  it('does not move while stunned', () => {
    const k = newKeeper();
    k.stun = 1;
    settle(k, newBall(40, 7, -20, 0), 'hard', 0.5);
    expect(k.y).toBe(3);
  });

  it('beats the ball out, and a fireball is put out by it', () => {
    const b = newBall(KEEPER_X + 3, 3, -25, 0);
    b.fire = true;
    const world: World = { side: 'A', wall: false, keeper: { x: KEEPER_X, y0: 3, y1: 3, vy: 0, r: KEEPER_R } };
    const ev = run(b, 0.2, world);
    expect(ev).toContainEqual(expect.objectContaining({ type: 'keeper', fire: true }));
    expect(b.vx).toBeGreaterThan(0);
    expect(b.fire).toBe(false);
  });
});

describe('new arenas', () => {
  it('every arena has a name, a look, and room for the kickoff ball', () => {
    for (const kind of ARCADE_ARENAS) {
      const a = ARENAS[kind];
      expect(a.name.length).toBeGreaterThan(3);
      expect(a.palette.sky).toHaveLength(5);
      // Kickoff drops at 42 m, 12 m up; the second ball at 36 m.
      const drop = newBall(42, Math.min(12, a.roof - 1), 0, 0);
      const ev = run(drop, 0.05, { side: 'A', wall: false, arena: a });
      expect(ev.filter((e) => e.type === 'bumper' || e.type === 'bounce')).toHaveLength(0);
    }
  });

  it('the windmill bar blocks a ball and swats it on', () => {
    const arena = ARENAS.windmill;
    const s = arena.spinner!;
    // At time 0 the bar lies flat; drop a ball onto one arm.
    const b = newBall(s.x + 3, s.y + 2, 0, -8);
    const ev = run(b, 0.3, { side: 'A', wall: false, arena, time: 0 });
    expect(ev.some((e) => e.type === 'bounce' && e.kind === 'wall')).toBe(true);
    expect(b.y).toBeGreaterThan(s.y);
  });

  it('a sliding bumper is where the clock says it is', () => {
    const arena = ARENAS.crusher;
    const m = arena.movers[0];
    expect(moverY(m, 0)).toBeCloseTo(m.y);
    expect(moverY(m, m.period / 4)).toBeCloseTo(m.y + m.amp);
    const top = moverY(m, m.period / 4);
    const b = newBall(m.x + 3, top, -20, 0);
    const ev = run(b, 0.15, { side: 'A', wall: false, arena, time: m.period / 4 });
    expect(ev.some((e) => e.type === 'bumper')).toBe(true);
  });

  it('a pillar stops a low ball but not one lobbed over it', () => {
    const arena = ARENAS.pillars;
    const k = arena.blocks[0];
    const low = newBall(k.x1 + 3, 2, -20, 0);
    run(low, 0.3, { side: 'A', wall: false, arena });
    expect(low.x).toBeGreaterThan(k.x1);
    const high = newBall(k.x1 + 3, k.y1 + 4, -20, 2);
    run(high, 0.3, { side: 'A', wall: false, arena });
    expect(high.x).toBeLessThan(k.x0);
  });

  it('a low roof keeps the ball under it', () => {
    const arena = ARENAS.lowroof;
    const b = newBall(40, 5, 0, 30);
    const ev: SimEvent[] = [];
    for (let i = 0; i < 1 / DT; i++) {
      stepWorld(b, null, DT, { side: 'A', wall: false, arena }, t, ev);
      expect(b.y).toBeLessThanOrEqual(arena.roof - t.ballRadius + 1e-9);
    }
    expect(ev.some((e) => e.type === 'bounce' && e.kind === 'roof')).toBe(true);
  });

  it('knows which spots are clear of its objects', () => {
    expect(spotIsFree(ARENAS.pinball, 27, 15)).toBe(false);
    expect(spotIsFree(ARENAS.pinball, 15, 8)).toBe(true);
    expect(spotIsFree(ARENAS.lowroof, 35, 12)).toBe(false);
    expect(spotIsFree(ARENAS.windmill, 30, 12)).toBe(false);
  });
});

describe('hazards', () => {
  it('a gravity well drags a passing ball towards it', () => {
    const free = newBall(30, 14, 12, 0);
    run(free, 0.5, { side: 'A', wall: false });
    const pulled = newBall(30, 14, 12, 0);
    run(pulled, 0.5, { side: 'A', wall: false, wells: [{ x: 34, y: 20 }] });
    expect(pulled.y).toBeGreaterThan(free.y);
  });

  it('mud stops a rolling ball almost at once and swallows a bounce', () => {
    const grass = newBall(20, t.ballRadius, 15, 0);
    run(grass, 0.6, { side: 'A', wall: false });
    const mud = newBall(20, t.ballRadius, 15, 0);
    run(mud, 0.6, { side: 'A', wall: false, mud: [[19, 40]] });
    expect(mud.x).toBeLessThan(grass.x - 2);

    const drop = newBall(25, 6, 0, 0);
    const ev = run(drop, 2, { side: 'A', wall: false, mud: [[19, 40]] });
    expect(drop.onGround).toBe(true);
    expect(ev.filter((e) => e.type === 'bounce' && e.kind === 'ground').length).toBeLessThanOrEqual(1);
  });

  function director(rules: Partial<ArcadeRules> = {}) {
    const events: EventMsg[] = [];
    const host: ArcadeHost = {
      rng: () => 0.5,
      matchMs: RULES.matchMs,
      changed: () => {},
      event: (e) => events.push(e),
      hasExtraBall: () => false,
      extraBall: () => {},
    };
    const all: ArcadeRules = { keeper: 'normal', powerups: false, modifiers: false, hazards: true, growing: false, frenzy: false };
    const a = new Arcade(host, 'pinball', { ...all, ...rules });
    const play = (ms: number) => {
      for (let left = ms; left > 0; left -= 200) a.advance(Math.min(200, left), false);
    };
    return { a, events, play };
  }

  it('appears at the same spot on both halves, announced three seconds ahead', () => {
    const { a, play } = director();
    play(ARCADE.hazardFirstMs);
    const items = a.state().items;
    expect(items).toHaveLength(2);
    expect(isHazard(items[0].kind)).toBe(true);
    expect(items[0].kind).toBe(items[1].kind);
    expect(items[0].lx).toBe(items[1].lx);
    expect(items.map((i) => i.half).sort()).toEqual(['A', 'B']);
    expect(items[0].liveInMs).toBe(ARCADE.itemWarnMs);
  });

  it('clears away when its time is up', () => {
    const { a, play } = director();
    play(ARCADE.hazardFirstMs + ARCADE.itemWarnMs + 12_000 + 400);
    expect(a.state().items).toHaveLength(0);
  });

  it('is not scheduled when hazards are switched off', () => {
    const { a, play } = director({ hazards: false });
    play(60_000);
    expect(a.state().items).toHaveLength(0);
  });

  it('never offers Keeper Off when there is no keeper', () => {
    const { a, play } = director({ hazards: false, powerups: true, keeper: 'off' });
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      play(20_000);
      for (const item of a.state().items) seen.add(item.kind);
    }
    expect(seen.has('nokeeper')).toBe(false);
  });
});
