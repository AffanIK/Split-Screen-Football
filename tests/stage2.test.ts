import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchClient } from '../src/client/match';
import { Room } from '../src/server/room';
import { champion, makeBracket, nextTie, report, withdraw } from '../src/shared/bracket';
import { PRESETS } from '../src/shared/config';
import type { ClientMsg, FullTimeMsg, MatchStateMsg, RoomStateMsg, ServerMsg, Slot, ViewMsg } from '../src/shared/protocol';
import { RULES } from '../src/shared/rules';

describe('bracket', () => {
  const play = (b: ReturnType<typeof makeBracket>) => {
    // The first-named player wins every tie.
    for (let at = nextTie(b); at; at = nextTie(b)) report(b, at, b[at[0]][at[1]].a!, [5, 0]);
  };

  it('draws every player exactly once, for any number from 3 to 8', () => {
    for (let n = 3; n <= 8; n++) {
      const ids = Array.from({ length: n }, (_, i) => i);
      const b = makeBracket(ids);
      const drawn = b[0].flatMap((t) => [t.a, t.b]).filter((x) => x !== null);
      expect([...drawn].sort()).toEqual(ids);
      expect(b[0]).toHaveLength(n <= 4 ? 2 : 4);
    }
  });

  it('gives a bye straight through to the next round, never to another bye', () => {
    const b = makeBracket([0, 1, 2], () => 0.5);
    const byes = b[0].filter((t) => t.a === null || t.b === null);
    expect(byes).toHaveLength(1);
    expect(byes[0].done).toBe(true);
    expect(byes[0].winner).not.toBeNull();
    for (const t of b[0]) expect(t.a !== null || t.b !== null).toBe(true);
  });

  it('plays through to one champion', () => {
    for (let n = 3; n <= 8; n++) {
      const b = makeBracket(Array.from({ length: n }, (_, i) => i));
      expect(champion(b)).toBeNull();
      play(b);
      expect(champion(b)).not.toBeNull();
      expect(nextTie(b)).toBeNull();
    }
  });

  it('a player who leaves loses any tie still to play', () => {
    const b = makeBracket([0, 1, 2, 3], () => 0.5);
    const first = b[0][0];
    withdraw(b, first.a!);
    expect(first.done).toBe(true);
    expect(first.winner).toBe(first.b);
    play(b);
    expect(champion(b)).not.toBe(first.a);
  });

  it('a winner who then leaves does not block the final', () => {
    const b = makeBracket([0, 1, 2, 3], () => 0.5);
    const at = nextTie(b)!;
    const winner = b[at[0]][at[1]].a!;
    report(b, at, winner, [5, 0]);
    withdraw(b, winner);
    play(b);
    expect(champion(b)).not.toBeNull();
    expect(champion(b)).not.toBe(winner);
  });
});

function setup(n: number, names = ['SAM', 'ALEX', 'KIM', 'JO', 'PAT', 'LEE', 'RAY', 'MAX']) {
  const sent: { slot: Slot; m: ServerMsg }[] = [];
  const room = new Room('TEST', (slot, m) => sent.push({ slot, m }), { rng: () => 0, rules: { stallMs: 10_000_000 } });
  room.config = { ...PRESETS.classic };
  const ids: Slot[] = [];
  for (let i = 0; i < n; i++) {
    const p = room.add({ name: names[i] })!;
    room.sync(p.slot);
    ids.push(p.slot);
  }
  const of = <T extends ServerMsg['type']>(slot: Slot, type: T) =>
    sent.filter((s) => s.slot === slot && s.m.type === type).map((s) => s.m as Extract<ServerMsg, { type: T }>);
  const roomState = () => of(0, 'room_state').at(-1) as RoomStateMsg;
  const seatOf = (id: Slot) => room.players[id]?.seat ?? null;
  const at = (seat: string) => room.players.findIndex((p) => p?.seat === seat) as Slot;
  const ready = (...who: Slot[]) => who.forEach((id) => room.onMessage(id, { type: 'ready', ready: true }));
  /** The runner of whichever half has the main ball concedes. */
  const concede = () => {
    const id = at(`${room.relay.owner}1`);
    room.onMessage(id, { type: 'goal', seq: room.relay.seq, speed: 10, clean: false });
  };
  return { room, sent, of, roomState, seatOf, at, ready, concede, ids };
}

describe('seats and watchers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('seats the first two and lets later arrivals watch, even mid-match', () => {
    const { room, seatOf, ready } = setup(3);
    expect([seatOf(0), seatOf(1), seatOf(2)]).toEqual(['A1', 'B1', null]);
    ready(0, 1);
    vi.advanceTimersByTime(RULES.countdownMs);
    const late = room.add({ name: 'late' })!;
    expect(room.players[late.slot]!.seat).toBeNull();
  });

  it('a watch link never takes a seat', () => {
    const { room } = setup(1);
    const w = room.add({ name: 'eye', watch: true })!;
    expect(room.players[w.slot]).toMatchObject({ seat: null, watch: true });
    expect(room.add()!.slot).toBe(2);
    expect(room.players[2]!.seat).toBe('B1');
  });

  it('a seated player can stand up to watch, and a watcher can take the empty seat', () => {
    const { room, seatOf } = setup(3);
    room.onMessage(1, { type: 'set_seat', seat: null });
    expect(seatOf(1)).toBeNull();
    room.onMessage(2, { type: 'set_seat', seat: 'B1' });
    expect(seatOf(2)).toBe('B1');
    // A watcher cannot push someone out of a taken seat.
    room.onMessage(1, { type: 'set_seat', seat: 'A1' });
    expect(seatOf(0)).toBe('A1');
    expect(seatOf(1)).toBeNull();
  });

  it('the match starts on the seated players alone; a watcher need not be ready', () => {
    const { room, ready } = setup(3);
    ready(0, 1);
    expect(room.phase).toBe('countdown');
  });

  it('a watcher leaving or dropping never pauses the match', () => {
    const { room, ready } = setup(3);
    ready(0, 1);
    vi.advanceTimersByTime(RULES.countdownMs);
    room.disconnect(2);
    expect(room.phase).toBe('playing');
    expect(room.players[2]).toBeNull();
  });

  it('passes the hosting on when the host leaves the lobby', () => {
    const { room } = setup(3);
    room.disconnect(0);
    expect(room.host).toBe(1);
    room.onMessage(2, { type: 'set_config', patch: { goals: 10 } });
    expect(room.config.goals).toBe(5);
    room.onMessage(1, { type: 'set_config', patch: { goals: 10 } });
    expect(room.config.goals).toBe(10);
  });

  it('sends what a runner sees to the watchers but not to the opponent', () => {
    const { room, of, ready } = setup(3);
    ready(0, 1);
    vi.advanceTimersByTime(RULES.countdownMs);
    const view: ViewMsg = { type: 'view', balls: [], feet: [], keeper: null, meter: 0.4, ghost: false };
    room.onMessage(0, view);
    expect(of(2, 'view')).toHaveLength(1);
    expect(of(2, 'view')[0]).toMatchObject({ side: 'A', meter: 0.4 });
    expect(of(1, 'view')).toHaveLength(0);
    // Someone who is not running a half cannot describe one.
    room.onMessage(2, view);
    expect(of(0, 'view')).toHaveLength(0);
  });

  it('shows an emote from a watcher with their name and no side', () => {
    const { room, of } = setup(3);
    room.onMessage(2, { type: 'emote', id: 0 });
    expect(of(0, 'emote')[0]).toEqual({ type: 'emote', side: null, name: 'KIM', id: 0 });
  });
});

describe('2 v 2', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function four() {
    const s = setup(4);
    s.room.onMessage(0, { type: 'set_team', size: 2 });
    s.room.onMessage(2, { type: 'set_seat', seat: 'A2' });
    s.room.onMessage(3, { type: 'set_seat', seat: 'B2' });
    return s;
  }

  it('only the host can change the team size, and it opens two more seats', () => {
    const { room, seatOf } = setup(4);
    room.onMessage(1, { type: 'set_team', size: 2 });
    expect(room.team).toBe(1);
    room.onMessage(2, { type: 'set_seat', seat: 'A2' });
    expect(seatOf(2)).toBeNull();
    room.onMessage(0, { type: 'set_team', size: 2 });
    room.onMessage(2, { type: 'set_seat', seat: 'A2' });
    expect(seatOf(2)).toBe('A2');
  });

  it('needs all four seated and ready', () => {
    const { room, ready } = four();
    ready(0, 1, 2);
    expect(room.phase).toBe('lobby');
    ready(3);
    expect(room.phase).toBe('countdown');
  });

  it('going back to 1 v 1 sends the second players to watch', () => {
    const { room, seatOf } = four();
    room.onMessage(0, { type: 'set_team', size: 1 });
    expect([seatOf(0), seatOf(1), seatOf(2), seatOf(3)]).toEqual(['A1', 'B1', null, null]);
  });

  it('gives the ball to seat 1 of a side, and takes ball messages from nobody else', () => {
    const { room, of, ready } = four();
    ready(0, 1, 2, 3);
    vi.advanceTimersByTime(RULES.countdownMs);
    expect(of(0, 'spawn')).toHaveLength(1);
    expect(of(2, 'spawn')).toHaveLength(0);
    const seq = room.relay.seq;
    room.onMessage(2, { type: 'handoff', seq: seq + 1, y: 5, vx: 20, vy: 0, t: 0 });
    room.onMessage(2, { type: 'goal', seq, speed: 10, clean: false });
    expect(room.relay.owner).toBe('A');
    expect(room.score).toEqual({ A: 0, B: 0 });
  });

  it("passes the second player's boot to their runner, and the runner's view back", () => {
    const { room, of, ready } = four();
    ready(0, 1, 2, 3);
    vi.advanceTimersByTime(RULES.countdownMs);
    room.onMessage(2, { type: 'foot', x: 20, y: 5 });
    expect(of(0, 'foot')).toEqual([{ type: 'foot', x: 20, y: 5 }]);
    expect(of(1, 'foot')).toHaveLength(0);
    room.onMessage(0, { type: 'view', balls: [], feet: [], keeper: null, meter: 0, ghost: false });
    expect(of(2, 'view')).toHaveLength(1);
    expect(of(1, 'view')).toHaveLength(0);
    expect(of(3, 'view')).toHaveLength(0);
  });

  it('when the runner drops, their teammate takes over the half and gets a fresh ball', () => {
    const { room, of, ready, seatOf } = four();
    ready(0, 1, 2, 3);
    vi.advanceTimersByTime(RULES.countdownMs);
    room.disconnect(0);
    expect(room.phase).toBe('playing');
    expect(seatOf(2)).toBe('A1');
    expect(of(2, 'spawn')).toHaveLength(1);
    expect(room.relay.owner).toBe('A');
  });

  it('when the second player drops, play simply carries on', () => {
    const { room, ready, seatOf } = four();
    ready(0, 1, 2, 3);
    vi.advanceTimersByTime(RULES.countdownMs);
    room.disconnect(3);
    expect(room.phase).toBe('playing');
    expect(seatOf(1)).toBe('B1');
  });

  it('pauses only when a whole side has gone', () => {
    const { room, ready } = four();
    ready(0, 1, 2, 3);
    vi.advanceTimersByTime(RULES.countdownMs);
    room.disconnect(1);
    expect(room.phase).toBe('playing');
    room.disconnect(3);
    expect(room.phase).toBe('paused');
    vi.advanceTimersByTime(RULES.rejoinMs);
    expect(room.phase).toBe('full_time');
  });
});

describe('tournament', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function started(n: number) {
    const s = setup(n);
    s.room.onMessage(0, { type: 'set_format', format: 'tournament' });
    s.room.onMessage(0, { type: 'start_tournament' });
    /** Play the current tie: the left-hand player wins 5-0. */
    const playTie = () => {
      s.ready(s.at('A1'), s.at('B1'));
      vi.advanceTimersByTime(RULES.countdownMs);
      for (let i = 0; i < 5; i++) {
        // Only side B ever concedes.
        if (s.room.relay.owner === 'A') {
          s.room.onMessage(s.at('A1'), { type: 'handoff', seq: s.room.relay.seq + 1, y: 5, vx: 20, vy: 0, t: 0 });
        }
        s.concede();
        vi.advanceTimersByTime(RULES.goalPauseMs);
      }
    };
    return { ...s, playTie };
  }

  it('needs at least three players and the host to start it', () => {
    const two = setup(2);
    two.room.onMessage(0, { type: 'set_format', format: 'tournament' });
    two.room.onMessage(0, { type: 'start_tournament' });
    expect(two.room.bracket).toBeNull();

    const four = setup(4);
    four.room.onMessage(0, { type: 'set_format', format: 'tournament' });
    four.room.onMessage(1, { type: 'start_tournament' });
    expect(four.room.bracket).toBeNull();
    four.room.onMessage(0, { type: 'start_tournament' });
    expect(four.room.bracket).not.toBeNull();
  });

  it('leaves out anyone who joined only to watch', () => {
    const s = setup(3);
    const w = s.room.add({ name: 'eye', watch: true })!;
    s.room.onMessage(0, { type: 'set_format', format: 'tournament' });
    s.room.onMessage(0, { type: 'start_tournament' });
    const drawn = s.room.bracket![0].flatMap((t) => [t.a, t.b]);
    expect(drawn).not.toContain(w.slot);
  });

  it('seats two players at a time and has the rest watch', () => {
    const { room, roomState } = started(4);
    const seated = room.players.filter((p) => p?.seat);
    expect(seated.map((p) => p!.seat).sort()).toEqual(['A1', 'B1']);
    expect(roomState().bracket).toMatchObject({ champion: null });
    expect(roomState().bracket!.current).not.toBeNull();
  });

  it('starts the tie by itself if the two players do not press ready', () => {
    const { room } = started(4);
    expect(room.phase).toBe('lobby');
    vi.advanceTimersByTime(RULES.nextTieMs);
    expect(room.phase).toBe('countdown');
  });

  it('plays every tie in turn and crowns a champion', () => {
    const { room, roomState, playTie, of } = started(4);
    const firstPair = [room.players.findIndex((p) => p?.seat === 'A1'), room.players.findIndex((p) => p?.seat === 'B1')];
    playTie();
    expect(room.phase).toBe('full_time');
    expect((of(0, 'full_time').at(-1) as FullTimeMsg).seriesOver).toBe(true);
    // The result shows for a moment, then the next two are seated.
    vi.advanceTimersByTime(RULES.resultMs);
    expect(room.phase).toBe('lobby');
    const secondPair = [room.players.findIndex((p) => p?.seat === 'A1'), room.players.findIndex((p) => p?.seat === 'B1')];
    expect(secondPair).not.toEqual(firstPair);
    playTie();
    vi.advanceTimersByTime(RULES.resultMs);
    playTie();
    vi.advanceTimersByTime(RULES.resultMs);
    const b = roomState().bracket!;
    expect(b.champion).not.toBeNull();
    expect(b.current).toBeNull();
    expect(room.players.some((p) => p?.seat)).toBe(false);
  });

  it('a player who leaves gives their tie to the other player', () => {
    const { room, at } = started(4);
    const leaver = at('A1');
    const stays = at('B1');
    room.onMessage(leaver, { type: 'leave' });
    expect(room.bracket![0].some((t) => t.done && t.winner === stays)).toBe(true);
    expect(room.players[leaver]).toBeNull();
  });

  it('the host can end it and get the ordinary lobby back', () => {
    const { room } = started(4);
    room.onMessage(1, { type: 'end_tournament' });
    expect(room.bracket).not.toBeNull();
    room.onMessage(0, { type: 'end_tournament' });
    expect(room.bracket).toBeNull();
    expect(room.players.filter((p) => p?.seat)).toHaveLength(2);
  });
});

describe('watcher and second-player clients', () => {
  function client(seat: 'A1' | 'A2' | null, others: { id: number; seat: 'A1' | 'A2' | 'B1' | null }[] = []) {
    const sent: ClientMsg[] = [];
    let now = 0;
    const c = new MatchClient((m) => sent.push(m), { type: 'create' }, () => now, 500);
    const p = (id: number, s: 'A1' | 'A2' | 'B1' | null) => ({
      id,
      seat: s,
      side: s ? (s[0] as 'A' | 'B') : null,
      ready: true,
      connected: true,
      name: `P${id}`,
      streak: 0,
      watch: false,
    });
    c.onMessage({ type: 'joined', code: 'TEST', token: 't', you: 9 });
    c.onMessage({
      type: 'room_state',
      code: 'TEST',
      players: [p(9, seat), p(1, 'B1'), ...others.map((o) => p(o.id, o.seat))],
      host: 9,
      config: PRESETS.classic,
      team: 2,
      format: 'match',
      bracket: null,
    });
    const state = (phase: MatchStateMsg['phase']): MatchStateMsg => ({
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
      arcade: null,
    });
    c.onMessage(state('countdown'));
    c.onMessage(state('playing'));
    return { c, sent, advance: (ms: number) => (now += ms) };
  }

  it('knows its own seat and whether it runs a half', () => {
    expect(client('A1').c).toMatchObject({ side: 'A', runs: true, watching: false });
    expect(client('A2').c).toMatchObject({ side: 'A', runs: false, watching: false });
    expect(client(null).c).toMatchObject({ side: null, runs: false, watching: true });
  });

  it('names a side by both of its players', () => {
    const { c } = client('A1', [{ id: 4, seat: 'A2' }]);
    expect(c.nameOf('A')).toBe('P9+P4');
    expect(c.nameOf('B')).toBe('P1');
  });

  it('a second player and a watcher never simulate a ball', () => {
    for (const seat of ['A2', null] as const) {
      const { c } = client(seat);
      c.onMessage({ type: 'spawn', seq: 1 });
      const y = c.ball?.y;
      for (let i = 0; i < 30; i++) c.step(null, []);
      expect(c.ball?.y).toBe(y);
    }
  });

  it('describes its half only when someone is relying on it', () => {
    const alone = client('A1');
    alone.c.onMessage({ type: 'spawn', seq: 1 });
    alone.advance(100);
    alone.c.tick();
    expect(alone.sent.some((m) => m.type === 'view')).toBe(false);

    for (const other of ['A2', null] as const) {
      const seen = client('A1', [{ id: 4, seat: other }]);
      seen.c.onMessage({ type: 'spawn', seq: 1 });
      seen.advance(100);
      seen.c.tick();
      const view = seen.sent.find((m) => m.type === 'view') as ViewMsg;
      expect(view.balls).toHaveLength(1);
    }
  });

  it("uses a teammate's boot as a second foot, and stuns it separately", () => {
    const { c } = client('A1', [{ id: 4, seat: 'A2' }]);
    c.onMessage({ type: 'spawn', seq: 1 });
    const b = c.ball!;
    const ev: Parameters<typeof c.step>[1] = [];
    c.step(null, ev, { x0: b.x - 3, y0: b.y, x1: b.x + 3, y1: b.y, vx: 30, vy: 0 });
    expect(ev.some((e) => e.type === 'kick')).toBe(true);
    expect(c.ball!.vx).toBeGreaterThan(0);
  });

  it('moves a watched ball on by the age of the report, and drops a stale one', () => {
    const { c, advance } = client(null);
    const ball = { id: 0, x: 20, y: 5, vx: 10, vy: 0, angle: 0, fire: false };
    c.onMessage({ type: 'view', side: 'A', balls: [ball], feet: [], keeper: null, meter: 0, ghost: false });
    advance(50);
    expect(c.viewOf('A')!.balls[0].x).toBeCloseTo(20.5);
    expect(c.viewOf('B')).toBeNull();
    advance(1000);
    expect(c.viewOf('A')).toBeNull();
  });

  it('a second player reports their boot, but not more often than it is needed', () => {
    const { c, sent, advance } = client('A2');
    c.sendFoot(10, 5);
    c.sendFoot(11, 5);
    advance(30);
    c.sendFoot(12, 5);
    expect(sent.filter((m) => m.type === 'foot')).toEqual([
      { type: 'foot', x: 10, y: 5 },
      { type: 'foot', x: 12, y: 5 },
    ]);
  });
});
