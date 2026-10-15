import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room } from '../src/server/room';
import { Rooms } from '../src/server/rooms';
import type { EventMsg, FullTimeMsg, MatchStateMsg, ServerMsg, Slot } from '../src/shared/protocol';
import { PRESETS } from '../src/shared/config';
import { CODE_ALPHABET, RULES, makeCode, parseCode } from '../src/shared/rules';

function setup(rules: Partial<typeof RULES> = {}) {
  const sent: { slot: Slot; m: ServerMsg }[] = [];
  // rng 0 gives the first kickoff to A, who is the creator in slot 0.
  const room = new Room('TEST', (slot, m) => sent.push({ slot, m }), { rules, rng: () => 0 });
  // These are the base rules; Arcade mode has its own tests.
  room.config = { ...PRESETS.classic };
  const a = room.add()!;
  room.sync(a.slot);
  const b = room.add()!;
  room.sync(b.slot);
  const of = <T extends ServerMsg['type']>(slot: Slot, type: T) =>
    sent.filter((s) => s.slot === slot && s.m.type === type).map((s) => s.m as Extract<ServerMsg, { type: T }>);
  const events = () => of(0, 'event') as EventMsg[];
  const state = () => of(0, 'match_state').at(-1) as MatchStateMsg;
  const ready = () => {
    room.onMessage(0, { type: 'ready', ready: true });
    room.onMessage(1, { type: 'ready', ready: true });
  };
  /** Ready up and run the countdown. */
  const kickOff = () => {
    ready();
    vi.advanceTimersByTime(RULES.countdownMs);
  };
  /** The current owner concedes. */
  const concede = () => {
    const slot = room.players.findIndex((p) => p?.side === room.relay.owner) as Slot;
    room.onMessage(slot, { type: 'goal', seq: room.relay.seq, speed: 20, clean: false });
  };
  return { room, sent, of, events, state, ready, kickOff, concede, a, b };
}

describe('lobby', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('puts the creator on the left and the friend on the right; anyone after that watches', () => {
    const { room } = setup();
    expect(room.players[0]!.side).toBe('A');
    expect(room.players[1]!.side).toBe('B');
    const third = room.add()!;
    expect(room.players[third.slot]!.seat).toBeNull();
    // A room holds eight people in all.
    for (let i = 0; i < 5; i++) expect(room.add()).not.toBeNull();
    expect(room.add()).toBeNull();
  });

  it('swaps sides when either player picks the other one', () => {
    const { room } = setup();
    room.onMessage(1, { type: 'set_side', side: 'A' });
    expect(room.players[0]!.side).toBe('B');
    expect(room.players[1]!.side).toBe('A');
  });

  it('lets only the creator choose the series length', () => {
    const { room } = setup();
    room.onMessage(1, { type: 'set_config', patch: { series: 3 } });
    expect(room.config.series).toBe(1);
    room.onMessage(0, { type: 'set_config', patch: { series: 3 } });
    expect(room.config.series).toBe(3);
    // The series length is not part of a preset.
    expect(room.config.preset).toBe('classic');
  });

  it('counts down once both are ready, then gives the kickoff ball to one side', () => {
    const { room, of, ready, state } = setup();
    room.onMessage(0, { type: 'ready', ready: true });
    expect(room.phase).toBe('lobby');
    ready();
    expect(state().phase).toBe('countdown');
    expect(of(0, 'spawn')).toHaveLength(0);
    vi.advanceTimersByTime(RULES.countdownMs);
    expect(state().phase).toBe('playing');
    expect(of(0, 'spawn')).toHaveLength(1);
    expect(of(1, 'spawn')).toHaveLength(0);
  });

  it('frees the place of a player who leaves the lobby', () => {
    const { room } = setup();
    room.disconnect(1);
    expect(room.players[1]).toBeNull();
    expect(room.add()).not.toBeNull();
  });
});

describe('match', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives a goal to the other player, pauses, then the conceder kicks off', () => {
    const { room, of, kickOff, concede, state, events } = setup();
    kickOff();
    concede();
    expect(room.score).toEqual({ A: 0, B: 1 });
    expect(state().phase).toBe('goal');
    expect(events().at(-1)).toMatchObject({ kind: 'goal', side: 'B' });
    vi.advanceTimersByTime(RULES.goalPauseMs);
    expect(state().phase).toBe('playing');
    expect(room.relay.owner).toBe('A');
    expect(of(0, 'spawn')).toHaveLength(2);
  });

  it('counts each ball once: a repeated or stale goal message is ignored', () => {
    const { room, kickOff } = setup();
    kickOff();
    const seq = room.relay.seq;
    room.onMessage(0, { type: 'goal', seq, speed: 20, clean: false });
    room.onMessage(0, { type: 'goal', seq, speed: 20, clean: false });
    vi.advanceTimersByTime(RULES.goalPauseMs);
    room.onMessage(0, { type: 'goal', seq, speed: 20, clean: false });
    expect(room.score).toEqual({ A: 0, B: 1 });
  });

  it('ignores a goal claimed by the player who does not have the ball', () => {
    const { room, kickOff } = setup();
    kickOff();
    room.onMessage(1, { type: 'goal', seq: room.relay.seq, speed: 20, clean: false });
    expect(room.score).toEqual({ A: 0, B: 0 });
  });

  it('calls a clean, fast goal a screamer', () => {
    const { room, kickOff, events } = setup();
    kickOff();
    room.onMessage(0, { type: 'goal', seq: room.relay.seq, speed: 33, clean: true });
    expect(events().at(-1)).toMatchObject({ kind: 'goal', screamer: true });
  });

  it('ends at five goals and announces match point on the way', () => {
    const { room, kickOff, concede, of, events } = setup();
    kickOff();
    for (let i = 0; i < 5; i++) {
      concede();
      vi.advanceTimersByTime(RULES.goalPauseMs);
    }
    expect(room.phase).toBe('full_time');
    expect(events().filter((e) => e.kind === 'match_point')).toHaveLength(1);
    const ft = of(1, 'full_time')[0] as FullTimeMsg;
    expect(ft).toMatchObject({ winner: 'B', forfeit: false, seriesOver: true, score: { A: 0, B: 5 } });
    expect(ft.stats.B.goals).toBe(5);
  });

  it('stops the clock during a goal pause', () => {
    const { kickOff, concede, state } = setup();
    kickOff();
    vi.advanceTimersByTime(10_000);
    concede();
    vi.advanceTimersByTime(RULES.goalPauseMs);
    expect(state().remainingMs).toBe(RULES.matchMs - 10_000);
  });

  it('ends on time when someone leads', () => {
    const { room, kickOff, concede, of } = setup({ stallMs: 10_000_000 });
    kickOff();
    concede();
    vi.advanceTimersByTime(RULES.goalPauseMs + RULES.matchMs);
    expect(room.phase).toBe('full_time');
    expect(of(0, 'full_time')[0]).toMatchObject({ winner: 'B' });
  });

  it('goes to golden goal on a tie: the next goal wins', () => {
    const { room, kickOff, concede, events, state } = setup({ stallMs: 10_000_000 });
    kickOff();
    vi.advanceTimersByTime(RULES.matchMs);
    expect(room.phase).toBe('playing');
    expect(state().golden).toBe(true);
    expect(events().some((e) => e.kind === 'golden')).toBe(true);
    concede();
    vi.advanceTimersByTime(RULES.goalPauseMs);
    expect(room.phase).toBe('full_time');
  });

  it('announces the last minute', () => {
    const { kickOff, events } = setup({ stallMs: 10_000_000 });
    kickOff();
    vi.advanceTimersByTime(RULES.matchMs - 60_000);
    expect(events().some((e) => e.kind === 'last_minute')).toBe(true);
  });

  it('takes the ball off a player who keeps it for eight seconds', () => {
    const { room, kickOff, of, events } = setup();
    kickOff();
    vi.advanceTimersByTime(RULES.stallMs);
    expect(events().at(-1)).toMatchObject({ kind: 'stall', side: 'A' });
    expect(of(0, 'take_ball')).toHaveLength(1);
    expect(of(1, 'spawn')).toHaveLength(1);
    expect(room.relay.owner).toBe('B');
  });

  it('a handoff restarts the stalling timer', () => {
    const { room, kickOff, of } = setup();
    kickOff();
    vi.advanceTimersByTime(RULES.stallMs - 1000);
    room.onMessage(0, { type: 'handoff', seq: room.relay.seq + 1, y: 5, vx: 20, vy: 0, t: 0 });
    room.onMessage(1, { type: 'handoff_ack', seq: room.relay.seq });
    vi.advanceTimersByTime(RULES.stallMs - 1000);
    expect(of(1, 'take_ball')).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(of(1, 'take_ball')).toHaveLength(1);
  });

  it('reports possession from time on the ball', () => {
    const { room, kickOff, concede, of } = setup({ stallMs: 10_000_000, goalsToWin: 1 });
    kickOff();
    vi.advanceTimersByTime(3000);
    room.onMessage(0, { type: 'handoff', seq: room.relay.seq + 1, y: 5, vx: 20, vy: 0, t: 0 });
    vi.advanceTimersByTime(1000);
    concede();
    vi.advanceTimersByTime(RULES.goalPauseMs);
    const ft = of(0, 'full_time')[0] as FullTimeMsg;
    expect(ft.stats.A.possession).toBe(75);
    expect(ft.stats.B.possession).toBe(25);
  });

  it('keeps the stats each player reports for the current game', () => {
    const { room, kickOff, concede, of } = setup({ goalsToWin: 1 });
    kickOff();
    room.onMessage(0, { type: 'stat', game: 1, shots: 4, fastest: 31, saves: 2, juggle: 6 });
    room.onMessage(1, { type: 'stat', game: 7, shots: 9, fastest: 9, saves: 9, juggle: 9 });
    concede();
    vi.advanceTimersByTime(RULES.goalPauseMs);
    const ft = of(0, 'full_time')[0] as FullTimeMsg;
    expect(ft.stats.A).toMatchObject({ shots: 4, fastest: 31, saves: 2, juggle: 6 });
    expect(ft.stats.B.shots).toBe(0);
  });
});

describe('pause and rejoin', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pauses when a player drops, and resumes with a countdown when they return', () => {
    const { room, kickOff, state, a } = setup();
    kickOff();
    vi.advanceTimersByTime(5000);
    room.disconnect(1);
    expect(state()).toMatchObject({ phase: 'paused', pauseReason: 'disconnect' });
    vi.advanceTimersByTime(10_000);
    expect(room.rejoin('wrong')).toBeNull();
    void a;
    const slot = room.rejoin(room.players[1]!.token)!;
    room.sync(slot, true);
    expect(state().phase).toBe('countdown');
    vi.advanceTimersByTime(RULES.countdownMs);
    expect(state().phase).toBe('playing');
    // The clock did not run while paused.
    expect(state().remainingMs).toBe(RULES.matchMs - 5000);
  });

  it('gives the ball back to an owner who returns without it', () => {
    const { room, kickOff, of } = setup();
    kickOff();
    room.disconnect(0);
    room.sync(room.rejoin(room.players[0]!.token)!, true);
    vi.advanceTimersByTime(RULES.countdownMs);
    expect(of(0, 'spawn')).toHaveLength(2);
    expect(room.relay.owner).toBe('A');
  });

  it('awards the match to the other player after thirty seconds away', () => {
    const { room, kickOff, of } = setup();
    kickOff();
    room.disconnect(1);
    vi.advanceTimersByTime(RULES.rejoinMs);
    expect(room.phase).toBe('full_time');
    expect(of(0, 'full_time')[0]).toMatchObject({ winner: 'A', forfeit: true });
    expect(room.players[1]).toBeNull();
  });

  it('pauses for a hidden tab and carries straight on when it is shown again', () => {
    const { room, kickOff, state, of } = setup();
    kickOff();
    room.onMessage(1, { type: 'away', away: true });
    expect(state()).toMatchObject({ phase: 'paused', pauseReason: 'away' });
    room.onMessage(1, { type: 'away', away: false });
    vi.advanceTimersByTime(RULES.countdownMs);
    expect(state().phase).toBe('playing');
    // The owner kept its ball, so no new one is dropped.
    expect(of(0, 'spawn')).toHaveLength(1);
  });

  it('leaving mid-match forfeits at once', () => {
    const { room, kickOff, of } = setup();
    kickOff();
    room.onMessage(0, { type: 'leave' });
    expect(of(1, 'full_time')[0]).toMatchObject({ winner: 'B', forfeit: true });
  });
});

describe('series and rematch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const playGame = (s: ReturnType<typeof setup>) => {
    s.kickOff();
    s.concede();
    vi.advanceTimersByTime(RULES.goalPauseMs);
  };

  it('best of three needs two wins, and the kickoff alternates', () => {
    const s = setup({ goalsToWin: 1 });
    s.room.onMessage(0, { type: 'set_config', patch: { series: 3 } });
    playGame(s);
    expect((s.of(0, 'full_time').at(-1) as FullTimeMsg).seriesOver).toBe(false);
    expect(s.room.kickoff).toBe('A');
    s.ready();
    expect(s.room.kickoff).toBe('B');
    vi.advanceTimersByTime(RULES.countdownMs);
    s.concede();
    vi.advanceTimersByTime(RULES.goalPauseMs);
    // One win each, so a decider is needed.
    expect(s.room.seriesScore).toEqual({ A: 1, B: 1 });
    expect((s.of(0, 'full_time').at(-1) as FullTimeMsg).seriesOver).toBe(false);
    playGame(s);
    expect((s.of(0, 'full_time').at(-1) as FullTimeMsg).seriesOver).toBe(true);
  });

  it('a rematch keeps the room and starts a fresh series', () => {
    const s = setup({ goalsToWin: 1 });
    playGame(s);
    expect(s.room.seriesScore).toEqual({ A: 0, B: 1 });
    s.ready();
    expect(s.room.phase).toBe('countdown');
    expect(s.room.seriesScore).toEqual({ A: 0, B: 0 });
    expect(s.room.game).toBe(1);
    expect(s.room.score).toEqual({ A: 0, B: 0 });
  });
});

describe('room codes', () => {
  it('uses four letters with no look-alikes', () => {
    for (let i = 0; i < 200; i++) {
      const code = makeCode();
      expect(code).toHaveLength(4);
      expect(code).not.toMatch(/[IO01]/);
      expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
    }
  });

  it('tidies what a player types and rejects what cannot be a code', () => {
    expect(parseCode(' kxqt ')).toBe('KXQT');
    expect(parseCode('KXQ')).toBeNull();
    expect(parseCode('KOQT')).toBeNull();
    expect(parseCode('K1QT')).toBeNull();
  });

  it('closes a room that stays empty for ten minutes, but not one that is rejoined', () => {
    vi.useFakeTimers();
    const rooms = new Rooms();
    const gone = rooms.create();
    const kept = rooms.create();
    rooms.touch(gone);
    rooms.touch(kept);
    vi.advanceTimersByTime(RULES.emptyRoomMs - 1000);
    kept.room.add();
    rooms.touch(kept);
    vi.advanceTimersByTime(2000);
    expect(rooms.get(gone.room.code)).toBeUndefined();
    expect(rooms.get(kept.room.code)).toBe(kept);
    rooms.close();
    vi.useRealTimers();
  });
});
