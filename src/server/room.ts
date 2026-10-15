import { ARCADE_ARENAS } from '../shared/arena';
import { champion, makeBracket, nextTie, report, withdraw, type Bracket } from '../shared/bracket';
import { EMOTES, EMOTE_GAP_MS, PRESETS, cleanName, patchConfig, usesArcade, type Config } from '../shared/config';
import { speedLimitScale } from '../shared/effects';
import {
  ROOM_MAX,
  type BracketState,
  type ClientMsg,
  type EventMsg,
  type Format,
  type FullTimeMsg,
  type MatchStateMsg,
  type Phase,
  type PlayerStats,
  type Seat,
  type ServerMsg,
  type Slot,
  type TeamSize,
  type ViewMsg,
} from '../shared/protocol';
import { RULES, type Rules } from '../shared/rules';
import { other, type Side } from '../shared/types';
import { Arcade } from './arcade';
import { BallRelay, type RelayOptions } from './relay';

interface Player {
  token: string;
  /** Where they play; null while they watch. Seat 1 on each side runs that half. */
  seat: Seat | null;
  side: Side | null;
  ready: boolean;
  connected: boolean;
  /** Tab hidden. */
  away: boolean;
  name: string;
  streak: number;
  /** When they last sent an emote. */
  emoteAt: number;
  /** Joined to watch only: never drawn into a tournament. */
  watch: boolean;
}

/** What happens when the current countdown or goal pause ends. */
type Next = 'kickoff' | 'continue' | 'end';

type Reported = { shots: number; fastest: number; saves: number; juggle: number; keeper: number };

const noStats = (): Record<Side, Reported> => ({
  A: { shots: 0, fastest: 0, saves: 0, juggle: 0, keeper: 0 },
  B: { shots: 0, fastest: 0, saves: 0, juggle: 0, keeper: 0 },
});

/** How often the Arcade director looks at the clock while the ball is in play. */
const ARCADE_TICK_MS = 200;

const SEATS: Record<TeamSize, Seat[]> = { 1: ['A1', 'B1'], 2: ['A1', 'B1', 'A2', 'B2'] };
const sideOf = (seat: Seat | null): Side | null => (seat ? (seat[0] as Side) : null);

export interface RoomOptions extends RelayOptions {
  rules?: Partial<Rules>;
  rng?: () => number;
}

/**
 * One private room: the lobby, the referee and the scoreboard, for up to eight
 * people. It decides the phase, score and clock; the browsers only simulate the ball.
 */
export class Room {
  /** Members by id; a gap is null. */
  players: (Player | null)[] = [];
  /** Who sets the rules. */
  host: Slot = 0;
  /** The match rules, set by the host in the lobby. */
  config: Config = { ...PRESETS.arcade };
  team: TeamSize = 1;
  format: Format = 'match';
  phase: Phase = 'lobby';
  score: Record<Side, number> = { A: 0, B: 0 };
  seriesScore: Record<Side, number> = { A: 0, B: 0 };
  game = 0;
  golden = false;
  kickoff: Side = 'A';
  /** One relay per ball. The second ball only exists in Arcade mode. */
  readonly relays: [BallRelay, BallRelay];
  arcade: Arcade | null = null;
  /** The tournament in progress, if there is one. */
  bracket: Bracket | null = null;
  private tieAt: [number, number] | null = null;
  private bracketNames: Record<number, string> = {};
  private nextTieAt = 0;
  private bracketTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rule values forced by tests and the soak run, on top of the config. */
  private overrides: Partial<Rules>;
  private rng: () => number;
  private remainingMs = 0;
  private clockSince: number | null = null;
  private clockTimer: ReturnType<typeof setTimeout> | null = null;
  private minuteTimer: ReturnType<typeof setTimeout> | null = null;
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private forfeitTimer: ReturnType<typeof setTimeout> | null = null;
  private arcadeTimer: ReturnType<typeof setInterval> | null = null;
  private arcadeAt = 0;
  private forfeitAt = 0;
  private next: Next = 'kickoff';
  private timerMs = 0;
  private everPlayed = false;
  private seriesDone = false;
  private matchPointSaid: Record<Side, boolean> = { A: false, B: false };
  private reported = noStats();
  private possession: Record<Side, number> = { A: 0, B: 0 };
  private possSince: number | null = null;
  private possSide: Side = 'A';
  private lastFullTime: FullTimeMsg | null = null;

  constructor(
    readonly code: string,
    private sendSlot: (slot: Slot, m: ServerMsg) => void,
    opts: RoomOptions = {},
  ) {
    this.overrides = opts.rules ?? {};
    this.rng = opts.rng ?? Math.random;
    const relay = (id: number) => {
      const r = new BallRelay((to, m) => this.sendSide(to, m), opts, id);
      r.speedScale = (m) => speedLimitScale(this.arcade?.running ?? null, !!m.fire);
      return r;
    };
    this.relays = [relay(0), relay(1)];
    // Possession and the stalling whistle follow the main ball only.
    this.relay.onOwnerChange = () => {
      this.tallyPossession();
      if (this.phase === 'playing') {
        this.startPossession();
        this.armStall();
      }
    };
  }

  /** The numbers the referee works to: defaults, then the lobby's choices, then any test overrides. */
  private get rules(): Rules {
    return {
      ...RULES,
      matchMs: this.config.minutes * 60_000,
      goalsToWin: this.config.goals,
      ...this.overrides,
    };
  }

  /** The main ball. */
  get relay(): BallRelay {
    return this.relays[0];
  }

  get empty(): boolean {
    return !this.players.some((p) => p?.connected);
  }

  private at(seat: Seat): Player | null {
    return this.players.find((p) => p?.seat === seat) ?? null;
  }

  private idOf(p: Player): Slot {
    return this.players.indexOf(p);
  }

  private sit(p: Player, seat: Seat | null): void {
    p.seat = seat;
    p.side = sideOf(seat);
    p.ready = false;
  }

  /** The players on the pitch. */
  private get seated(): Player[] {
    return this.players.filter((p): p is Player => !!p?.seat);
  }

  /** Reserve a place for someone new. Call `sync` once their socket is ready. */
  add(who: { name?: string; streak?: number; watch?: boolean } = {}): { slot: Slot; token: string } | null {
    if (this.players.filter(Boolean).length >= ROOM_MAX) return null;
    let slot = this.players.findIndex((p) => !p);
    if (slot < 0) slot = this.players.length;
    // A free seat goes to whoever joins a lobby; anyone else watches until one is free.
    const open = (this.phase === 'lobby' || this.phase === 'full_time') && !this.bracket && !who.watch;
    const seat = open ? (SEATS[this.team].find((s) => !this.at(s)) ?? null) : null;
    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    if (!this.players.some(Boolean)) this.host = slot;
    this.players[slot] = {
      token,
      seat,
      side: sideOf(seat),
      ready: false,
      connected: true,
      away: false,
      name: cleanName(who.name),
      streak: Math.max(0, Math.min(999, Number(who.streak) | 0)),
      emoteAt: 0,
      watch: !!who.watch,
    };
    return { slot, token };
  }

  /** Someone who dropped out returns with the token they were given. */
  rejoin(token: string): Slot | null {
    const slot = this.players.findIndex((p) => p?.token === token);
    if (slot < 0) return null;
    const p = this.players[slot]!;
    p.connected = true;
    p.away = false;
    return slot;
  }

  /** Bring a newly attached socket up to date, and resume if everyone is back. */
  sync(slot: Slot, rejoined = false): void {
    this.broadcastRoom();
    this.sendSlot(slot, this.matchState());
    if (this.phase === 'full_time' && this.lastFullTime) this.sendSlot(slot, this.lastFullTime);
    const p = this.players[slot];
    if (rejoined && p?.side && p.seat?.endsWith('1')) {
      // A reloaded page has lost its balls, unless a handoff to it is still unconfirmed.
      const side = p.side;
      const lost = (r: BallRelay) => r.alive && !r.resendTo(side) && r.owner === side;
      if (lost(this.relays[1])) this.relays[1].kill();
      if (lost(this.relay)) {
        if (this.phase === 'paused' && this.next === 'continue') {
          this.next = 'kickoff';
          this.kickoff = side;
        } else if (this.phase === 'playing') {
          this.relay.spawn(side);
        }
      }
    }
    this.maybeResume();
  }

  disconnect(slot: Slot): void {
    const p = this.players[slot];
    if (!p) return;
    if (!p.seat || this.phase === 'lobby' || this.phase === 'full_time') {
      this.remove(slot);
    } else if (this.handOver(p)) {
      p.connected = false;
      this.broadcastRoom();
      // If the match was paused for them (a tab closing is hidden first), it can go on without them.
      this.maybeResume();
    } else {
      p.connected = false;
      this.broadcastRoom();
      this.pause();
    }
  }

  /**
   * In 2 v 2, a player dropping out leaves the half to their teammate, who
   * becomes its runner if they were not already. Returns false if there is no teammate.
   */
  private handOver(p: Player): boolean {
    const side = p.side!;
    const mate = this.seated.find((q) => q !== p && q.side === side && q.connected);
    if (!mate) return false;
    const wasRunner = p.seat!.endsWith('1');
    this.sit(p, null);
    if (wasRunner) {
      mate.seat = `${side}1` as Seat;
      // The balls were on the screen that has gone: drop fresh ones for the new runner.
      if (this.phase === 'playing') {
        for (const r of this.relays) if (r.alive && r.owner === side) r.spawn(side);
      } else if (this.next === 'continue' && this.relay.owner === side) {
        this.next = 'kickoff';
        this.kickoff = side;
      }
    }
    return true;
  }

  onMessage(slot: Slot, m: ClientMsg): void {
    const p = this.players[slot];
    if (!p) return;
    const side = p.side;
    const lobby = this.phase === 'lobby' && !this.bracket;
    const runs = !!p.seat?.endsWith('1');
    switch (m.type) {
      case 'set_side':
        if (m.side === 'A' || m.side === 'B') this.takeSeat(p, `${m.side}1` as Seat, lobby);
        break;
      case 'set_seat':
        if (m.seat === null) {
          if (lobby) {
            this.sit(p, null);
            this.broadcastRoom();
          }
        } else if (SEATS[this.team].includes(m.seat)) {
          this.takeSeat(p, m.seat, lobby);
        }
        break;
      case 'set_team':
        if (!lobby || slot !== this.host || (m.size !== 1 && m.size !== 2)) break;
        this.team = m.size;
        // Going back to 1 v 1 sends the second players to watch.
        for (const q of this.seated) if (!SEATS[this.team].includes(q.seat!)) this.sit(q, null);
        this.broadcastRoom();
        break;
      case 'set_format':
        if (!lobby || slot !== this.host || (m.format !== 'match' && m.format !== 'tournament')) break;
        this.format = m.format;
        this.broadcastRoom();
        break;
      case 'start_tournament':
        if (lobby && slot === this.host && this.format === 'tournament') this.startTournament();
        break;
      case 'end_tournament':
        if (slot === this.host && this.bracket && (this.phase === 'lobby' || this.phase === 'full_time')) {
          this.endTournament();
        }
        break;
      case 'set_config':
        if (!lobby || slot !== this.host || !m.patch || typeof m.patch !== 'object') break;
        this.config = patchConfig(this.config, m.patch);
        this.broadcastRoom();
        break;
      case 'emote': {
        const now = Date.now();
        if (!(m.id >= 0 && m.id < EMOTES.length) || now - p.emoteAt < EMOTE_GAP_MS) break;
        p.emoteAt = now;
        this.broadcast({ type: 'emote', side, name: p.name, id: m.id | 0 });
        break;
      }
      case 'ready':
        if (!p.seat || (this.phase !== 'lobby' && this.phase !== 'full_time')) break;
        // After a tournament tie the bracket moves on by itself.
        if (this.bracket && this.phase === 'full_time') break;
        p.ready = !!m.ready;
        this.broadcastRoom();
        this.maybeStart();
        break;
      case 'leave':
        if (!p.seat || this.phase === 'lobby' || this.phase === 'full_time') {
          this.remove(slot);
        } else if (this.handOver(p)) {
          this.remove(slot);
          this.maybeResume();
        } else {
          p.connected = false;
          this.finishGame(other(side!), true);
        }
        break;
      case 'away':
        if (!p.seat) break;
        p.away = !!m.away;
        if (p.away) this.pause();
        else this.maybeResume();
        break;
      case 'goal':
        if (side && runs) this.onGoal(side, this.relayFor(m.ball), m.seq, m.speed, m.clean);
        break;
      case 'stat':
        if (!side || !runs || m.game !== this.game) break;
        this.reported[side] = {
          shots: Math.max(0, m.shots | 0),
          fastest: Number.isFinite(m.fastest) ? Math.max(0, m.fastest) : 0,
          saves: Math.max(0, m.saves | 0),
          juggle: Math.max(0, m.juggle | 0),
          keeper: Math.max(0, (m.keeper ?? 0) | 0),
        };
        break;
      case 'callout':
        if (side && this.phase === 'playing' && ['save', 'bar', 'fire', 'stun', 'keeper'].includes(m.kind)) {
          this.broadcast({ type: 'event', kind: m.kind, side });
        }
        break;
      case 'pickup':
        if (side && runs && this.phase === 'playing' && (m.by === 'A' || m.by === 'B')) {
          this.arcade?.pickup(side, m.id, m.by);
        }
        break;
      case 'meter':
        if (side && runs && Number.isFinite(m.v)) {
          this.sendSide(other(side), { type: 'meter', side, v: Math.min(1, Math.max(0, m.v)), ghost: !!m.ghost });
        }
        break;
      case 'foot':
        // The second player's boot goes to whoever is running their half.
        if (side && !runs && Number.isFinite(m.x) && Number.isFinite(m.y)) {
          this.sendSide(side, { type: 'foot', x: m.x, y: m.y });
        }
        break;
      case 'view':
        if (side && runs) this.relayView(p, side, m);
        break;
      case 'handoff':
        if (side && runs && (this.phase === 'playing' || this.phase === 'paused')) {
          this.relayFor(m.ball)?.onHandoff(side, m);
        }
        break;
      case 'handoff_ack':
        if (side && runs) this.relayFor(m.ball)?.onAck(side, m.seq);
        break;
      case 'ball_preview':
        if (side && runs && this.phase === 'playing') this.relayFor(m.ball)?.onPreview(side, m);
        break;
      case 'ping':
        this.sendSlot(slot, { type: 'pong', t: m.t });
        break;
    }
  }

  /** Drop the second ball, unless it is already in play. */
  spawnExtraBall(side: Side | null): void {
    if (this.phase !== 'playing' || this.relays[1].alive) return;
    this.relays[1].spawn(side ?? other(this.relay.owner));
  }

  close(): void {
    this.stopTimers();
    if (this.bracketTimer) clearTimeout(this.bracketTimer);
    for (const r of this.relays) r.close();
  }

  private relayFor(ball: number | undefined): BallRelay | undefined {
    return this.relays[ball ?? 0];
  }

  /** Take a seat. An occupied one can only be had by swapping with its holder. */
  private takeSeat(p: Player, seat: Seat, lobby: boolean): void {
    if (!lobby || p.seat === seat) return;
    const holder = this.at(seat);
    if (holder) {
      if (!p.seat) return;
      this.sit(holder, p.seat);
    }
    this.sit(p, seat);
    this.broadcastRoom();
  }

  /** What a runner sees goes to everyone watching, and to their teammate. */
  private relayView(from: Player, side: Side, m: ViewMsg): void {
    if (!Array.isArray(m.balls) || !Array.isArray(m.feet)) return;
    const out: ServerMsg = { ...m, type: 'view', side };
    this.players.forEach((q, id) => {
      if (q && q !== from && q.connected && (!q.seat || q.side === side)) this.sendSlot(id, out);
    });
  }

  // --- match flow ---

  private maybeStart(): void {
    const needed = SEATS[this.team].map((s) => this.at(s));
    if (needed.every((q) => q?.ready && q.connected)) this.startGame();
  }

  private startGame(): void {
    if (this.bracketTimer) clearTimeout(this.bracketTimer);
    this.bracketTimer = null;
    if (this.seriesDone) {
      this.seriesScore = { A: 0, B: 0 };
      this.game = 0;
      this.seriesDone = false;
    }
    this.game++;
    this.score = { A: 0, B: 0 };
    this.golden = false;
    this.remainingMs = this.rules.matchMs;
    this.reported = noStats();
    this.possession = { A: 0, B: 0 };
    this.matchPointSaid = { A: false, B: false };
    this.lastFullTime = null;
    // Random for the very first kickoff, then it alternates.
    this.kickoff = this.everPlayed ? other(this.kickoff) : this.rng() < 0.5 ? 'A' : 'B';
    this.everPlayed = true;
    const arena =
      this.config.arena === 'random'
        ? ARCADE_ARENAS[Math.floor(this.rng() * ARCADE_ARENAS.length)]
        : this.config.arena;
    this.arcade = usesArcade(this.config)
      ? new Arcade(
          {
            rng: this.rng,
            matchMs: this.rules.matchMs,
            changed: () => this.broadcastMatch(),
            event: (e) => this.broadcast(e),
            hasExtraBall: () => this.relays[1].alive,
            extraBall: (side) => this.spawnExtraBall(side),
          },
          arena,
          this.config,
        )
      : null;
    for (const p of this.players) if (p) p.ready = false;
    this.broadcastRoom();
    this.countdown('kickoff');
  }

  private countdown(next: Next): void {
    this.phase = 'countdown';
    this.next = next;
    this.timerMs = this.rules.countdownMs;
    this.phaseTimer = setTimeout(() => this.runNext(), this.rules.countdownMs);
    this.broadcastMatch();
  }

  private runNext(): void {
    this.phaseTimer = null;
    if (this.next === 'end') {
      this.finishGame(this.score.A > this.score.B ? 'A' : 'B', false);
      return;
    }
    this.phase = 'playing';
    this.startClock();
    this.broadcastMatch();
    if (this.next === 'kickoff') {
      this.relay.spawn(this.kickoff);
      // During the frenzy every kickoff has two balls.
      if (this.arcade?.frenzy) this.spawnExtraBall(null);
      for (const s of ['A', 'B'] as const) {
        if (this.score[s] >= this.rules.goalsToWin - 1 && !this.matchPointSaid[s]) {
          this.matchPointSaid[s] = true;
          this.broadcast({ type: 'event', kind: 'match_point', side: s });
        }
      }
    }
  }

  private onGoal(side: Side, relay: BallRelay | undefined, seq: number, speed: number, clean: boolean): void {
    // Only the owner of a live ball can concede with it, and only once per ball.
    if (this.phase !== 'playing' || !relay?.alive || side !== relay.owner || seq !== relay.seq) return;
    const scorer = other(side);
    const points = this.arcade?.frenzy ? 2 : 1;
    this.score[scorer] += points;
    this.leavePlaying();
    // A goal stops play: every ball is dead.
    for (const r of this.relays) r.kill();
    this.kickoff = side;
    const shot = Number.isFinite(speed) ? Math.max(0, speed) : 0;
    this.broadcast({
      type: 'event',
      kind: 'goal',
      side: scorer,
      speed: shot,
      screamer: !!clean && shot >= this.rules.screamerSpeed,
      points,
    });
    this.phase = 'goal';
    this.next = this.golden || this.score[scorer] >= this.rules.goalsToWin ? 'end' : 'kickoff';
    this.timerMs = this.rules.goalPauseMs;
    this.phaseTimer = setTimeout(() => this.runNext(), this.rules.goalPauseMs);
    this.broadcastMatch();
  }

  private onTimeUp(): void {
    this.clockTimer = null;
    this.remainingMs = 0;
    this.clockSince = null;
    if (this.score.A !== this.score.B) {
      this.finishGame(this.score.A > this.score.B ? 'A' : 'B', false);
    } else {
      this.golden = true;
      this.tickArcade();
      this.broadcast({ type: 'event', kind: 'golden' });
      this.broadcastMatch();
    }
  }

  private onStall(): void {
    this.stallTimer = null;
    if (this.phase !== 'playing') return;
    const from = this.relay.owner;
    this.broadcast({ type: 'event', kind: 'stall', side: from });
    this.relay.take();
    this.relay.spawn(other(from));
  }

  private finishGame(winner: Side, forfeit: boolean): void {
    this.leavePlaying();
    this.stopTimers();
    for (const r of this.relays) r.kill();
    this.seriesScore[winner]++;
    // A tournament tie is always a single game.
    this.seriesDone = forfeit || !!this.bracket || this.config.series === 1 || this.seriesScore[winner] >= 2;
    this.phase = 'full_time';
    const total = this.possession.A + this.possession.B;
    const stats = (s: Side): PlayerStats => ({
      goals: this.score[s],
      ...this.reported[s],
      possession: total > 0 ? Math.round((this.possession[s] / total) * 100) : 50,
    });
    this.lastFullTime = {
      type: 'full_time',
      winner,
      forfeit,
      score: { ...this.score },
      seriesScore: { ...this.seriesScore },
      seriesOver: this.seriesDone,
      stats: { A: stats('A'), B: stats('B') },
    };

    if (this.bracket && this.tieAt) {
      const tie = this.bracket[this.tieAt[0]][this.tieAt[1]];
      // Side A was the tie's first player.
      report(this.bracket, this.tieAt, winner === 'A' ? tie.a! : tie.b!, [this.score.A, this.score.B]);
      this.tieAt = null;
      this.bracketTimer = setTimeout(() => this.nextTournamentTie(), this.rules.resultMs);
    }

    // Anyone who is not here for the result gives up their place.
    this.players.forEach((p, i) => {
      if (p && !p.connected) this.drop(i);
      else if (p) p.ready = p.away = false;
    });
    this.broadcastRoom();
    this.broadcastMatch();
    this.broadcast(this.lastFullTime);
    if (this.empty) this.reset();
  }

  // --- tournament ---

  private startTournament(): void {
    const entrants = this.players
      .map((p, id) => (p && p.connected && !p.watch ? id : -1))
      .filter((id) => id >= 0);
    if (entrants.length < 3) return;
    this.bracket = makeBracket(entrants, this.rng);
    this.bracketNames = {};
    for (const id of entrants) this.bracketNames[id] = this.players[id]!.name;
    this.team = 1;
    this.nextTournamentTie();
  }

  /** Seat the next two players, or stop at the champion. */
  private nextTournamentTie(): void {
    this.bracketTimer = null;
    if (!this.bracket) return;
    for (const p of this.players) if (p) this.sit(p, null);
    // Skip ties whose players have gone.
    let at = nextTie(this.bracket);
    while (at) {
      const tie = this.bracket[at[0]][at[1]];
      const gone = [tie.a!, tie.b!].filter((id) => !this.players[id]?.connected);
      if (!gone.length) break;
      for (const id of gone) withdraw(this.bracket, id);
      at = nextTie(this.bracket);
    }
    this.tieAt = at;
    this.phase = 'lobby';
    this.score = { A: 0, B: 0 };
    this.seriesScore = { A: 0, B: 0 };
    this.lastFullTime = null;
    this.arcade = null;
    if (at) {
      const tie = this.bracket[at[0]][at[1]];
      this.sit(this.players[tie.a!]!, 'A1');
      this.sit(this.players[tie.b!]!, 'B1');
      // It starts by itself if the two players dawdle.
      this.nextTieAt = Date.now() + this.rules.nextTieMs;
      this.bracketTimer = setTimeout(() => {
        this.bracketTimer = null;
        if (this.phase === 'lobby' && this.at('A1')?.connected && this.at('B1')?.connected) this.startGame();
      }, this.rules.nextTieMs);
    }
    this.broadcastRoom();
    this.broadcastMatch();
  }

  private endTournament(): void {
    if (this.bracketTimer) clearTimeout(this.bracketTimer);
    this.bracketTimer = null;
    this.bracket = null;
    this.tieAt = null;
    this.reset();
    // Back to an ordinary lobby: the first players in take the seats.
    for (const p of this.players) if (p) this.sit(p, null);
    for (const p of this.players) {
      const seat = SEATS[this.team].find((s) => !this.at(s));
      if (p && !p.watch && seat) this.sit(p, seat);
    }
    this.broadcastRoom();
    this.broadcastMatch();
  }

  private bracketState(): BracketState | null {
    if (!this.bracket) return null;
    const waiting = this.bracketTimer && this.tieAt && this.phase === 'lobby';
    return {
      rounds: this.bracket,
      current: this.tieAt,
      champion: champion(this.bracket),
      names: this.bracketNames,
      startInMs: waiting ? Math.max(0, this.nextTieAt - Date.now()) : null,
    };
  }

  // --- pausing ---

  private get live(): boolean {
    return this.phase === 'countdown' || this.phase === 'playing' || this.phase === 'goal';
  }

  private pause(): void {
    // Already paused: the reason may have changed (a hidden tab that then dropped).
    if (this.phase === 'paused') this.broadcastMatch();
    if (!this.live) return;
    if (this.phase === 'playing') this.next = 'continue';
    this.leavePlaying();
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = null;
    this.phase = 'paused';
    this.forfeitAt = Date.now() + this.rules.rejoinMs;
    this.forfeitTimer = setTimeout(() => this.onForfeit(), this.rules.rejoinMs);
    this.broadcastMatch();
  }

  private maybeResume(): void {
    if (this.phase !== 'paused' || !this.seated.every((p) => p.connected && !p.away)) return;
    if (this.forfeitTimer) clearTimeout(this.forfeitTimer);
    this.forfeitTimer = null;
    if (this.next === 'end') this.runNext();
    else this.countdown(this.next);
  }

  private onForfeit(): void {
    this.forfeitTimer = null;
    const here = (['A', 'B'] as const).filter((s) => this.seated.some((p) => p.side === s && p.connected && !p.away));
    if (here.length === 1) {
      this.finishGame(here[0], true);
    } else {
      this.stopTimers();
      for (const r of this.relays) r.kill();
      this.players.forEach((p, i) => {
        if (p && !p.connected) this.drop(i);
      });
      this.reset();
      this.broadcastRoom();
      this.broadcastMatch();
    }
  }

  // --- clock, stalling, possession, arcade time ---

  private startClock(): void {
    this.startPossession();
    this.armStall();
    if (this.arcade) {
      this.arcadeAt = Date.now();
      this.arcadeTimer = setInterval(() => this.tickArcade(), ARCADE_TICK_MS);
    }
    if (this.golden) return;
    this.clockSince = Date.now();
    this.clockTimer = setTimeout(() => this.onTimeUp(), this.remainingMs);
    if (this.remainingMs > 60_000) {
      this.minuteTimer = setTimeout(
        () => this.broadcast({ type: 'event', kind: 'last_minute' }),
        this.remainingMs - 60_000,
      );
    }
  }

  /** Give the Arcade director the play time that has passed since it last looked. */
  private tickArcade(): void {
    if (!this.arcade || this.phase !== 'playing') return;
    const now = Date.now();
    const dt = now - this.arcadeAt;
    this.arcadeAt = now;
    if (dt > 0) this.arcade.advance(dt, this.golden);
  }

  /** Stop everything that only runs while the ball is in play. */
  private leavePlaying(): void {
    this.tallyPossession();
    this.tickArcade();
    if (this.arcadeTimer) clearInterval(this.arcadeTimer);
    this.arcadeTimer = null;
    if (this.clockSince !== null) {
      this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.clockSince));
      this.clockSince = null;
    }
    for (const t of [this.clockTimer, this.minuteTimer, this.stallTimer]) if (t) clearTimeout(t);
    this.clockTimer = this.minuteTimer = this.stallTimer = null;
  }

  private armStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => this.onStall(), this.rules.stallMs);
  }

  private tallyPossession(): void {
    if (this.possSince === null) return;
    this.possession[this.possSide] += Date.now() - this.possSince;
    this.possSince = null;
  }

  /** Start timing the current owner's spell on the ball. */
  private startPossession(): void {
    this.possSide = this.relay.owner;
    this.possSince = Date.now();
  }

  private stopTimers(): void {
    for (const t of [this.phaseTimer, this.forfeitTimer, this.clockTimer, this.minuteTimer, this.stallTimer]) {
      if (t) clearTimeout(t);
    }
    if (this.arcadeTimer) clearInterval(this.arcadeTimer);
    this.arcadeTimer = null;
    this.phaseTimer = this.forfeitTimer = this.clockTimer = this.minuteTimer = this.stallTimer = null;
    this.clockSince = null;
  }

  // --- members and messaging ---

  /** Forget a member, without telling anyone yet. */
  private drop(slot: Slot): void {
    this.players[slot] = null;
    if (this.bracket) withdraw(this.bracket, slot);
    if (slot === this.host) {
      const next = this.players.findIndex(Boolean);
      if (next >= 0) this.host = next;
    }
  }

  /** Someone leaves while no match is being played. */
  private remove(slot: Slot): void {
    const wasSeated = !!this.players[slot]?.seat;
    this.drop(slot);
    if (wasSeated) {
      for (const p of this.seated) p.ready = false;
      if (this.bracket && this.phase === 'lobby') {
        // Their tie cannot be played: move the bracket on.
        if (this.bracketTimer) clearTimeout(this.bracketTimer);
        this.nextTournamentTie();
        return;
      }
      if (this.phase === 'full_time' && !this.bracket) this.reset();
    }
    this.broadcastRoom();
    this.broadcastMatch();
  }

  /** Back to an open lobby, ready for a new pairing. */
  private reset(): void {
    this.phase = 'lobby';
    this.score = { A: 0, B: 0 };
    this.seriesScore = { A: 0, B: 0 };
    this.game = 0;
    this.seriesDone = false;
    this.lastFullTime = null;
    this.arcade = null;
  }

  private matchState(): MatchStateMsg {
    const running = this.clockSince !== null ? Date.now() - this.clockSince : 0;
    return {
      type: 'match_state',
      phase: this.phase,
      score: { ...this.score },
      remainingMs: Math.max(0, this.remainingMs - running),
      golden: this.golden,
      game: this.game,
      series: this.bracket ? 1 : this.config.series,
      seriesScore: { ...this.seriesScore },
      kickoff: this.kickoff,
      timerMs: this.phase === 'paused' ? Math.max(0, this.forfeitAt - Date.now()) : this.timerMs,
      pauseReason:
        this.phase !== 'paused' ? null : this.seated.some((p) => !p.connected) ? 'disconnect' : 'away',
      arcade: this.arcade?.state() ?? null,
    };
  }

  private broadcastMatch(): void {
    this.broadcast(this.matchState());
  }

  private broadcastRoom(): void {
    const players = [];
    for (let id = 0; id < this.players.length; id++) {
      const p = this.players[id];
      if (!p) continue;
      players.push({
        id,
        seat: p.seat,
        side: p.side,
        ready: p.ready,
        connected: p.connected,
        name: p.name,
        streak: p.streak,
        watch: p.watch,
      });
    }
    this.broadcast({
      type: 'room_state',
      code: this.code,
      players,
      host: this.host,
      config: this.config,
      team: this.team,
      format: this.format,
      bracket: this.bracketState(),
    });
  }

  private broadcast(m: ServerMsg | EventMsg): void {
    for (let id = 0; id < this.players.length; id++) if (this.players[id]) this.sendSlot(id, m);
  }

  /** Ball messages go to whoever is running that half. */
  private sendSide(side: Side, m: ServerMsg): void {
    const runner = this.at(`${side}1` as Seat);
    if (runner) this.sendSlot(this.idOf(runner), m);
  }
}
