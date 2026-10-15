import { ARENAS } from '../shared/arena';
import { DT, GOAL_H, HALF_X, RESEND_MS, WORLD_W, tuning, type Tuning } from '../shared/constants';
import type { Config } from '../shared/config';
import { ARCADE, effectiveTuning, isHazard, windNow, type ItemKind, type ModKind, type PowerKind } from '../shared/effects';
import { KEEPER_R, KEEPER_X, newKeeper, stepKeeper } from '../shared/keeper';
import type { FootSweep } from '../shared/foot';
import { entryBall, kickoffBall, shouldHandOff } from '../shared/handoff';
import { isGoal, stepWorld } from '../shared/physics';
import type {
  ArcadeState,
  ClientMsg,
  EventMsg,
  FullTimeMsg,
  HandoffMsg,
  MatchStateMsg,
  Phase,
  FootView,
  PlayerInfo,
  RoomStateMsg,
  Seat,
  ServerMsg,
  Slot,
  ViewMsg,
} from '../shared/protocol';
import type { Ball, Side, SimEvent, World } from '../shared/types';

const PREVIEW_MS = 100;
const METER_MS = 250;
/** How often a half is described to watchers and a teammate, and a second boot to its runner. */
const VIEW_MS = 33;
const FOOT_MS = 25;
/** A view older than this is not drawn. */
const VIEW_STALE_S = 0.5;
const GHOST_S = 0.5;
/** A handoff at least this fast counts as a shot. */
const SHOT_SPEED = 15;

export type Intent = { type: 'create' } | { type: 'join'; code: string; token?: string; watch?: boolean };

/** A boot as the game loop knows it. */
export interface FootNow {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Everything this client tracks about one of the match's balls. */
interface Held {
  id: number;
  /** The ball, while this side owns it. */
  ball: Ball | null;
  /** Drawn sliding off the edge for a moment after a handoff. */
  ghost: Ball | null;
  ghostLeft: number;
  /** Latest position streamed by the opponent while they own it. */
  remote: { x: number; y: number; vx: number; vy: number; at: number } | null;
  seq: number;
  pendingOut: { msg: HandoffMsg; lastSent: number } | null;
  previewAt: number;
  goalSent: boolean;
  /** How the ball arrived and what has happened to it since. */
  entrySpeed: number;
  onTarget: boolean;
  touched: boolean;
  barSaid: boolean;
  keeperSaid: boolean;
}

export interface ItemNow {
  id: number;
  kind: ItemKind;
  x: number;
  y: number;
  /** Seconds until it can be collected; 0 once live. */
  liveIn: number;
  /** Seconds until it disappears. */
  left: number;
  mine: boolean;
}

export interface ModNow {
  kind: ModKind;
  running: boolean;
  /** Seconds until it starts (if announced) or ends (if running). */
  secs: number;
  /** 0..1 of its run remaining. */
  share: number;
}

/**
 * One player's view of the room, the match and its balls. It simulates a ball
 * only while this side owns it. No DOM here, so the soak bots run exactly this code.
 */
export class MatchClient {
  code: string | null = null;
  token: string | null = null;
  you: Slot | null = null;
  /** The host computer's address on the local network, if the server knows it. */
  lan: string | null = null;
  room: RoomStateMsg | null = null;
  state: MatchStateMsg | null = null;
  result: FullTimeMsg | null = null;
  error: 'not_found' | 'full' | null = null;

  stats = { out: 0, in: 0, dup: 0, resent: 0, dropped: 0, transitMs: 0 };
  /** This player's own numbers for the full-time screen. */
  mine = { shots: 0, fastest: 0, saves: 0, juggle: 0, keeper: 0 };
  /** This side's goalkeeper bot. */
  keeper = newKeeper();

  /** Super meter, 0..1. Full means the next hard kick is a fireball. */
  meter = 0;
  /** A ghost shot is waiting to be used. */
  ghostReady = false;
  theirMeter = 0;
  theirGhost = false;
  /** Seconds this player's boot is still stunned for. */
  stunLeft = 0;
  /** The same for a teammate's boot, when this client runs the half in 2 v 2. */
  mateStun = 0;
  /** This player's boot, set by the game loop each frame so it can be shown to others. */
  myFoot: FootNow | null = null;
  /** The teammate's boot as last reported, when this client runs the half. */
  mate: { x: number; y: number; at: number } | null = null;
  /** Each half as last described by its runner, for watchers and second players. */
  views: Partial<Record<Side, { v: ViewMsg; at: number }>> = {};

  onEvent: ((e: EventMsg) => void) | null = null;
  onPhase: ((phase: Phase, prev: Phase | null) => void) | null = null;
  onEmote: ((side: Side | null, name: string, id: number) => void) | null = null;
  /** A mine went off at this spot on this screen. */
  onBlast: ((x: number, y: number) => void) | null = null;

  private held = new Map<number, Held>();
  private claimed = new Set<number>();
  private stateAt = 0;
  // Far enough back that the first of each is sent at once.
  private meterAt = -1e9;
  private viewAt = -1e9;
  private footAt = -1e9;
  private meterSent = '';
  private steps = 0;
  private lastTouch = -1000;
  private run = 0;

  constructor(
    private send: (m: ClientMsg) => void,
    private intent: Intent,
    private now: () => number = () => performance.now(),
    private resendMs = RESEND_MS,
    private t: Tuning = tuning,
    private who: { name?: string; streak?: number } = {},
  ) {}

  /** Call whenever the socket opens. A dropped connection rejoins with its token. */
  open(): void {
    if (this.code && this.token) this.send({ type: 'join_room', code: this.code, token: this.token, ...this.who });
    else if (this.intent.type === 'create') this.send({ type: 'create_room', ...this.who });
    else {
      const { code, token, watch } = this.intent;
      this.send({ type: 'join_room', code, token, watch, ...this.who });
    }
    for (const h of this.held.values()) {
      if (!h.pendingOut) continue;
      h.pendingOut.lastSent = this.now();
      this.send(h.pendingOut.msg);
    }
  }

  // --- what the rest of the client reads ---

  /** This client's own entry in the room. */
  get me(): PlayerInfo | null {
    return this.room?.players.find((p) => p.id === this.you) ?? null;
  }

  get side(): Side | null {
    return this.me?.side ?? null;
  }

  get seat(): Seat | null {
    return this.me?.seat ?? null;
  }

  /** Seat 1 on a side simulates that half; a second player and watchers only draw it. */
  get runs(): boolean {
    return !!this.seat?.endsWith('1');
  }

  /** In the room but not on the pitch. */
  get watching(): boolean {
    return !!this.me && !this.seat;
  }

  get isHost(): boolean {
    return !!this.room && this.room.host === this.you;
  }

  /** Everyone seated on one side. */
  team(side: Side): PlayerInfo[] {
    return (this.room?.players ?? []).filter((p) => p.side === side).sort((a, b) => (a.seat! < b.seat! ? -1 : 1));
  }

  get phase(): Phase | null {
    return this.state?.phase ?? null;
  }

  /** The balls move in these phases; everywhere else they are frozen. */
  get live(): boolean {
    return this.phase === 'playing' || this.phase === 'goal';
  }

  /** Both halves have someone to run them. */
  get hasOpponent(): boolean {
    const seats = (this.room?.players ?? []).map((p) => p.seat);
    return seats.includes('A1') && seats.includes('B1');
  }

  /** The main ball, while this side owns it. */
  get ball(): Ball | null {
    return this.held.get(0)?.ball ?? null;
  }

  get ghost(): Ball | null {
    return this.held.get(0)?.ghost ?? null;
  }

  /** Sequence number of the main ball. */
  get seq(): number {
    return this.held.get(0)?.seq ?? 0;
  }

  /** Every ball this side is simulating. */
  balls(): Ball[] {
    const out: Ball[] = [];
    for (const h of this.held.values()) if (h.ball) out.push(h.ball);
    return out;
  }

  ghosts(): Ball[] {
    const out: Ball[] = [];
    for (const h of this.held.values()) if (h.ghost) out.push(h.ghost);
    return out;
  }

  /** Match clock now, in ms. */
  clockMs(): number {
    const s = this.state;
    if (!s) return 0;
    if (s.phase !== 'playing' || s.golden) return s.remainingMs;
    return Math.max(0, s.remainingMs - (this.now() - this.stateAt));
  }

  /** Time left on the current countdown or forfeit timer, in ms. */
  timerMs(): number {
    return this.state ? Math.max(0, this.state.timerMs - (this.now() - this.stateAt)) : 0;
  }

  // --- arcade: everything is derived from the last state the server sent ---

  get arcade(): ArcadeState | null {
    return this.state?.arcade ?? null;
  }

  /** Play time that has passed since the last state arrived; arcade timers only run in play. */
  playSince(): number {
    return this.phase === 'playing' ? this.now() - this.stateAt : 0;
  }

  /** Power-ups acting on one side right now, with seconds left. */
  effectsOn(side: Side): { kind: PowerKind; secs: number; share: number }[] {
    const el = this.playSince();
    return (this.arcade?.effects ?? [])
      .filter((e) => e.side === side && e.leftMs - el > 0)
      .map((e) => ({ kind: e.kind, secs: (e.leftMs - el) / 1000, share: (e.leftMs - el) / e.totalMs }));
  }

  private has(kind: PowerKind): boolean {
    return !!this.side && this.effectsOn(this.side).some((e) => e.kind === kind);
  }

  get frozen(): boolean {
    return this.has('freeze');
  }

  /** The modifier that is announced or running. */
  modNow(): ModNow | null {
    const m = this.arcade?.mod;
    if (!m) return null;
    const el = this.playSince();
    if (el < m.startsInMs) return { kind: m.kind, running: false, secs: (m.startsInMs - el) / 1000, share: 1 };
    const left = m.leftMs - (el - m.startsInMs);
    return left > 0 ? { kind: m.kind, running: true, secs: left / 1000, share: left / ARCADE.modRunMs } : null;
  }

  /** The tuning this screen simulates with right now. */
  tuningNow(): Tuning {
    return this.tuningOf(this.side);
  }

  /** The tuning in force on one half: the modifier, plus the power-ups acting on that side's boots. */
  tuningOf(side: Side | null): Tuning {
    if (!this.arcade) return this.t;
    const mod = this.modNow();
    const onThem = side ? this.effectsOn(side).map((e) => e.kind) : [];
    return effectiveTuning(this.t, mod?.running ? mod.kind : null, onThem);
  }

  /** A side's super meter, from wherever this client knows it. */
  meterOf(side: Side): { v: number; ghost: boolean } {
    if (this.runs && side === this.side) return { v: this.meter, ghost: this.ghostReady };
    const seen = this.views[side]?.v;
    if (seen) return { v: seen.meter, ghost: seen.ghost };
    return { v: this.theirMeter, ghost: this.theirGhost };
  }

  /** Height of this player's own goal right now. */
  goalH(): number {
    return this.goalHOf(this.side);
  }

  /** Height of one side's goal: the grown height, taller still under a Big Goal power-up. */
  goalHOf(side: Side | null): number {
    const a = this.arcade;
    if (!a) return GOAL_H;
    const big = !!side && this.effectsOn(side).some((e) => e.kind === 'biggoal');
    return Math.min(ARENAS[a.arena].roof - 3, a.goalH * (big ? ARCADE.bigGoalMult : 1));
  }

  /** When the room's state last arrived, for counting down the bracket's timer. */
  roomAt = 0;

  /** Seconds until the next tournament tie starts by itself. */
  bracketStartIn(): number | null {
    const ms = this.room?.bracket?.startInMs;
    return ms === null || ms === undefined ? null : Math.max(0, (ms - (this.now() - this.roomAt)) / 1000);
  }

  portalsOpen(): boolean {
    const p = this.arcade?.portals;
    if (!p) return false;
    return this.playSince() < p.inMs ? p.open : !p.open;
  }

  /** Seconds until the portals change state. */
  portalSecs(): number {
    const p = this.arcade?.portals;
    return p ? Math.max(0, (p.inMs - this.playSince()) / 1000) : 0;
  }

  world(): World {
    const side = this.side ?? 'A';
    const a = this.arcade;
    if (!a) return { side, wall: false };
    const mod = this.modNow();
    return {
      side,
      wall: false,
      goalH: this.goalH(),
      wind: mod?.running ? windNow(mod.kind, mod.secs * 1000) : 0,
      arena: ARENAS[a.arena],
      portalsOpen: this.portalsOpen(),
      time: (a.playMs + this.playSince()) / 1000,
    };
  }

  /** Items on the pitch, in world coordinates. */
  itemsNow(): ItemNow[] {
    const el = this.playSince();
    return (this.arcade?.items ?? [])
      .filter((i) => !this.claimed.has(i.id))
      .map((i) => ({
        id: i.id,
        kind: i.kind,
        x: i.half === 'A' ? i.lx : WORLD_W - i.lx,
        y: i.y,
        liveIn: Math.max(0, (i.liveInMs - el) / 1000),
        left: Math.max(0, (i.leftMs - el) / 1000),
        mine: i.half === this.side,
      }));
  }

  // --- what the player does ---

  setSide(side: Side): void {
    this.send({ type: 'set_side', side });
  }

  setConfig(patch: Partial<Config>): void {
    this.send({ type: 'set_config', patch });
  }

  sendEmote(id: number): void {
    this.send({ type: 'emote', id });
  }

  /** The name of the player, or pair of players, on a side. */
  nameOf(side: Side): string {
    return this.team(side)
      .map((p) => p.name)
      .join('+');
  }

  setSeat(seat: Seat | null): void {
    this.send({ type: 'set_seat', seat });
  }

  /** A second player tells their half's runner where their boot is. */
  sendFoot(x: number, y: number): void {
    const now = this.now();
    if (now - this.footAt < FOOT_MS) return;
    this.footAt = now;
    this.send({ type: 'foot', x, y });
  }

  /** A half as its runner last described it, moved on by its age; null if there is nothing recent. */
  viewOf(side: Side): ViewMsg | null {
    const got = this.views[side];
    if (!got) return null;
    const age = (this.now() - got.at) / 1000;
    if (age > VIEW_STALE_S) return null;
    const lead = Math.min(age, 0.1);
    const g = this.tuningNow().gravity;
    return {
      ...got.v,
      balls: got.v.balls.map((b) => ({
        ...b,
        x: b.x + b.vx * lead,
        y: Math.max(0.3, b.y + b.vy * lead - 0.5 * g * lead * lead),
      })),
    };
  }

  /** The goalkeeper bot on this screen, if this match has one and it has not been sent away. */
  keeperOn(): boolean {
    return !!this.arcade && this.arcade.keeper !== 'off' && !this.has('nokeeper');
  }

  setReady(ready: boolean): void {
    this.send({ type: 'ready', ready });
  }

  setAway(away: boolean): void {
    this.send({ type: 'away', away });
  }

  leave(): void {
    this.send({ type: 'leave' });
  }

  onMessage(m: ServerMsg): void {
    switch (m.type) {
      case 'joined':
        this.code = m.code;
        this.token = m.token;
        this.you = m.you;
        this.lan = m.lan ?? null;
        this.error = null;
        break;
      case 'error':
        this.error = m.reason;
        break;
      case 'room_state':
        this.room = m;
        this.roomAt = this.now();
        break;
      case 'match_state': {
        const prev = this.state;
        this.state = m;
        this.stateAt = this.now();
        if (m.phase === 'countdown' && m.game !== prev?.game) {
          this.mine = { shots: 0, fastest: 0, saves: 0, juggle: 0, keeper: 0 };
          this.keeper = newKeeper();
          this.meter = this.theirMeter = this.stunLeft = this.mateStun = 0;
          this.views = {};
          this.ghostReady = this.theirGhost = false;
          this.claimed.clear();
          this.result = null;
          this.clearAll();
        }
        if (m.phase === 'full_time' || m.phase === 'lobby') this.clearAll();
        // A goal stops play: only the ball lying in the net stays on screen.
        if (m.phase === 'goal') for (const h of this.held.values()) if (!h.goalSent) this.clear(h);
        if (m.phase !== prev?.phase) this.onPhase?.(m.phase, prev?.phase ?? null);
        break;
      }
      case 'full_time':
        this.result = m;
        break;
      case 'event':
        if (m.kind === 'pickup' && m.side === this.side) {
          if (m.item === 'fireball') this.meter = 1;
          else if (m.item === 'ghost') this.ghostReady = true;
          else if (m.item === 'target') this.meter = Math.min(1, this.meter + ARCADE.meterTarget);
        }
        this.onEvent?.(m);
        break;
      case 'emote':
        this.onEmote?.(m.side, m.name, m.id);
        break;
      case 'view':
        this.views[m.side] = { v: m, at: this.now() };
        break;
      case 'foot':
        this.mate = { x: m.x, y: m.y, at: this.now() };
        break;
      case 'meter':
        this.theirMeter = m.v;
        this.theirGhost = m.ghost;
        break;
      case 'spawn': {
        if (!this.side) break;
        const h = this.rec(m.ball);
        h.seq = m.seq;
        this.clear(h);
        this.take(h, kickoffBall(this.side, h.id), 0);
        break;
      }
      case 'take_ball':
        this.clear(this.rec(m.ball));
        break;
      case 'handoff': {
        if (!this.side) break;
        const h = this.rec(m.ball);
        if (m.seq <= h.seq) {
          // A resend of a ball already received: confirm again, do not spawn a second one.
          this.stats.dup++;
          this.send({ type: 'handoff_ack', ball: h.id, seq: m.seq });
          break;
        }
        h.seq = m.seq;
        this.clear(h);
        this.take(h, entryBall(this.side, m, this.tuningNow().ballRadius), Math.hypot(m.vx, m.vy));
        this.stats.in++;
        this.stats.transitMs = Date.now() - m.t;
        this.send({ type: 'handoff_ack', ball: h.id, seq: m.seq });
        break;
      }
      case 'handoff_ok': {
        const h = this.rec(m.ball);
        if (h.pendingOut && h.pendingOut.msg.seq <= m.seq) h.pendingOut = null;
        if (h.ball && h.seq < m.seq) {
          h.ball = null;
          this.stats.dropped++;
        }
        break;
      }
      case 'drop_ball': {
        const h = this.rec(m.ball);
        if (h.pendingOut && h.pendingOut.msg.seq > m.seq) {
          h.pendingOut = null;
          h.ghost = null;
          this.stats.dropped++;
        }
        break;
      }
      case 'ball_preview': {
        const h = this.rec(m.ball);
        if (!h.ball) h.remote = { x: m.x, y: m.y, vx: m.vx, vy: m.vy, at: this.now() };
        break;
      }
    }
  }

  /** One fixed physics step. mateFoot is a teammate's boot, when this client runs a half in 2 v 2. */
  step(foot: FootSweep | null, ev: SimEvent[], mateFoot: FootSweep | null = null): void {
    const side = this.side;
    // Only the runner of a half simulates it.
    if (!side || !this.live || !this.runs) return;
    const arcade = this.arcade;
    const t = this.tuningNow();
    const world = this.world();
    this.steps++;

    if (this.stunLeft > 0) this.stunLeft -= DT;
    if (this.mateStun > 0) this.mateStun -= DT;
    if (arcade && this.phase === 'playing') this.meter = Math.min(1, this.meter + ARCADE.meterPerSecond * DT);

    // A stunned or frozen boot cannot touch anything. Only Arcade names the kicker.
    const usable = foot && this.stunLeft <= 0 && !this.frozen ? foot : null;
    const charged = this.meter >= 1;
    const mine = usable && arcade ? { ...usable, side, charged, id: 0 } : usable;
    const theirs = mateFoot && this.mateStun <= 0 && !this.frozen ? mateFoot : null;
    const second = theirs && arcade ? { ...theirs, side, charged, id: 1 } : theirs;
    const sweep = mine && second ? [mine, second] : (mine ?? second);
    const magnet = usable && this.has('magnet');
    const items = arcade && this.phase === 'playing' ? this.itemsNow().filter((i) => i.mine && i.liveIn <= 0) : [];

    // Wells and mud are part of the pitch while they last. Physics runs in side A's frame.
    const local = (x: number) => (side === 'A' ? x : WORLD_W - x);
    world.wells = items.filter((i) => i.kind === 'well').map((i) => ({ x: local(i.x), y: i.y }));
    world.mud = items
      .filter((i) => i.kind === 'mud')
      .map((i) => [local(i.x) - ARCADE.mudHalfWidth, local(i.x) + ARCADE.mudHalfWidth]);

    if (arcade && this.keeperOn() && arcade.keeper !== 'off') {
      const k = this.keeper;
      stepKeeper(k, this.balls(), side, arcade.keeper, world.goalH ?? GOAL_H, t, DT);
      world.keeper = { x: KEEPER_X, y0: k.prevY, y1: k.y, vy: k.vy, r: KEEPER_R };
    }

    for (const h of this.held.values()) {
      if (h.ghost) {
        stepWorld(h.ghost, null, DT, world, t, []);
        h.ghostLeft -= DT;
        if (h.ghostLeft <= 0) h.ghost = null;
      }
      const ball = h.ball;
      if (!ball) continue;

      if (magnet && usable) {
        const dx = usable.x1 - ball.x;
        const dy = usable.y1 - ball.y;
        const d = Math.hypot(dx, dy);
        if (d < ARCADE.magnetRange && d > 0.1) {
          ball.vx += (dx / d) * ARCADE.magnetPull * DT;
          ball.vy += (dy / d) * ARCADE.magnetPull * DT;
        }
      }

      const from = ev.length;
      stepWorld(ball, sweep, DT, world, t, ev);
      this.count(h, ev, from, ball);

      for (const item of items) {
        // Wells and mud act through the physics; everything else is used up by a touch.
        if (this.claimed.has(item.id) || (isHazard(item.kind) && item.kind !== 'mine')) continue;
        if (Math.hypot(ball.x - item.x, ball.y - item.y) < ARCADE.itemRadius + t.ballRadius) {
          this.claimed.add(item.id);
          if (item.kind === 'mine') this.blast(ball, item, usable, t);
          this.send({ type: 'pickup', id: item.id, by: ball.by ?? side });
        }
      }

      if (this.phase !== 'playing' || h.goalSent) continue;
      if (isGoal(ball, side, t, world.goalH)) {
        h.goalSent = true;
        this.send({ type: 'goal', ball: h.id, seq: h.seq, speed: h.entrySpeed, clean: !h.touched });
      } else if (shouldHandOff(ball, side, t.ballRadius)) {
        this.handOff(h);
      }
    }
  }

  /** Resend timers and the position and meter streams; call once per frame. */
  tick(): void {
    const now = this.now();
    for (const h of this.held.values()) {
      if (h.pendingOut && now - h.pendingOut.lastSent >= this.resendMs) {
        h.pendingOut.lastSent = now;
        this.stats.resent++;
        this.send(h.pendingOut.msg);
      }
      // A ghost shot gives the opponent no warning, so its position is not streamed.
      if (h.ball && this.phase === 'playing' && !this.ghostReady && now - h.previewAt >= PREVIEW_MS) {
        h.previewAt = now;
        const b = h.ball;
        this.send({ type: 'ball_preview', ball: h.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy });
      }
    }
    if (this.runs && this.live && this.watched() && now - this.viewAt >= VIEW_MS) {
      this.viewAt = now;
      this.send(this.describe());
    }
    if (this.runs && this.arcade && now - this.meterAt >= METER_MS) {
      this.meterAt = now;
      const key = `${this.meter.toFixed(2)}${this.ghostReady}`;
      if (key !== this.meterSent) {
        this.meterSent = key;
        this.send({ type: 'meter', v: this.meter, ghost: this.ghostReady });
      }
    }
  }

  /** Where the opponent's balls are now, extrapolated from the last updates. */
  remotes(): { x: number; y: number; vx: number; vy: number }[] {
    if (this.phase !== 'playing') return [];
    const out = [];
    const g = this.tuningNow().gravity;
    for (const h of this.held.values()) {
      const p = h.remote;
      if (!p || h.ball || h.ghost) continue;
      const age = (this.now() - p.at) / 1000;
      if (age > 0.4) continue;
      const y = Math.max(this.t.ballRadius, p.y + p.vy * age - 0.5 * g * age * age);
      out.push({ x: p.x + p.vx * age, y, vx: p.vx, vy: p.vy - g * age });
    }
    return out;
  }

  /** Heights at which the opponent's balls will enter, for those arriving within about a second. */
  incoming(): number[] {
    if (!this.side) return [];
    const g = this.tuningNow().gravity;
    const out = [];
    for (const p of this.remotes()) {
      const toward = this.side === 'A' ? -p.vx : p.vx;
      if (toward < 2) continue;
      const time = Math.abs(p.x - HALF_X) / toward;
      if (time <= 1.2) out.push(Math.max(this.t.ballRadius, p.y + p.vy * time - 0.5 * g * time * time));
    }
    return out;
  }

  // --- internals ---

  /** Is anyone relying on this client's description of its half? */
  private watched(): boolean {
    return (this.room?.players ?? []).some((p) => p.id !== this.you && p.connected && (!p.seat || p.side === this.side));
  }

  /** This half, for watchers and a teammate. */
  private describe(): ViewMsg {
    const state = (stun: number): FootView['state'] => (this.frozen ? 'frozen' : stun > 0 ? 'stun' : null);
    const feet: FootView[] = [];
    if (this.myFoot) feet.push({ ...this.myFoot, state: state(this.stunLeft) });
    // A teammate's boot is only known by position; the watcher's own tracker gives it a lean.
    if (this.mate) feet.push({ x: this.mate.x, y: this.mate.y, vx: 0, vy: 0, state: state(this.mateStun) });
    return {
      type: 'view',
      balls: [...this.balls(), ...this.ghosts()].map((b) => ({
        id: b.id,
        x: b.x,
        y: b.y,
        vx: b.vx,
        vy: b.vy,
        angle: b.angle,
        fire: b.fire,
      })),
      feet,
      keeper: this.keeperOn() ? { y: this.keeper.y, stunned: this.keeper.stun > 0 } : null,
      meter: this.meter,
      ghost: this.ghostReady,
    };
  }

  /** A mine goes off: the ball flies anywhere, and a boot standing close is stunned. */
  private blast(ball: Ball, mine: ItemNow, foot: FootSweep | null, t: Tuning): void {
    // Anywhere but straight down into the grass.
    const angle = Math.PI * (0.1 + Math.random() * 0.8);
    const speed = Math.min(t.maxShot, ARCADE.mineSpeedMin + Math.random() * (ARCADE.mineSpeedMax - ARCADE.mineSpeedMin));
    ball.vx = Math.cos(angle) * speed;
    ball.vy = Math.sin(angle) * speed;
    ball.fire = false;
    if (foot && Math.hypot(foot.x1 - mine.x, foot.y1 - mine.y) < ARCADE.mineStunRange) {
      this.stunLeft = ARCADE.mineStunMs / 1000;
    }
    this.onBlast?.(mine.x, mine.y);
  }

  private rec(id = 0): Held {
    let h = this.held.get(id);
    if (!h) {
      h = {
        id,
        ball: null,
        ghost: null,
        ghostLeft: 0,
        remote: null,
        seq: 0,
        pendingOut: null,
        previewAt: 0,
        goalSent: false,
        entrySpeed: 0,
        onTarget: false,
        touched: false,
        barSaid: false,
        keeperSaid: false,
      };
      this.held.set(id, h);
    }
    return h;
  }

  private take(h: Held, ball: Ball, entrySpeed: number): void {
    h.ball = ball;
    h.entrySpeed = entrySpeed;
    h.touched = false;
    h.barSaid = false;
    h.keeperSaid = false;
    h.goalSent = false;
    this.run = 0;
    h.onTarget = entrySpeed > 0 && this.headingIn(ball);
  }

  /** Would this ball go in if nobody touched it? */
  private headingIn(ball: Ball): boolean {
    const side = this.side!;
    const t = this.tuningNow();
    const world = this.world();
    const b = { ...ball };
    for (let i = 0; i < 3 / DT; i++) {
      stepWorld(b, null, DT, world, t, []);
      if (isGoal(b, side, t, world.goalH)) return true;
    }
    return false;
  }

  /** Stats, meter and callouts from what just happened to a ball. */
  private count(h: Held, ev: SimEvent[], from: number, ball: Ball): void {
    let dirty = false;
    const arcade = !!this.arcade;
    const gain = (v: number) => {
      if (arcade) this.meter = Math.min(1, this.meter + v);
    };
    for (let i = from; i < ev.length; i++) {
      const e = ev[i];
      if (e.type === 'kick') {
        // Once touched, a ghost ball can be seen again.
        ball.ghost = false;
        if (!h.touched) {
          h.touched = true;
          if (h.onTarget) {
            this.mine.saves++;
            dirty = true;
            gain(ARCADE.meterSave);
            this.send({ type: 'callout', kind: 'save' });
          }
        }
        // Taking the pace off a fast ball.
        if (e.before >= 10 && e.speed <= e.before * 0.45) gain(ARCADE.meterCushion);
        if (e.air && this.steps - this.lastTouch > 0.15 / DT) {
          this.run++;
          gain(ARCADE.meterJuggle);
          if (this.run > this.mine.juggle) {
            this.mine.juggle = this.run;
            dirty = true;
          }
        }
        this.lastTouch = this.steps;
      } else if (e.type === 'bounce') {
        if (e.kind === 'ground') this.run = 0;
        if (e.kind === 'post' && !h.touched && !h.barSaid && h.entrySpeed > 0 && e.speed > 8) {
          h.barSaid = true;
          this.send({ type: 'callout', kind: 'bar' });
        }
      } else if (e.type === 'keeper') {
        if (e.fire) this.keeper.stun = ARCADE.keeperStunMs / 1000;
        // A keeper save is one that stops a shot nobody else had touched.
        if (!h.touched && !h.keeperSaid && h.entrySpeed > 0) {
          h.keeperSaid = true;
          this.mine.keeper++;
          dirty = true;
          this.send({ type: 'callout', kind: 'keeper' });
        }
      } else if (e.type === 'fire') {
        this.meter = 0;
        this.send({ type: 'callout', kind: 'fire' });
      } else if (e.type === 'stun') {
        if (e.foot === 1) this.mateStun = e.ms / 1000;
        else this.stunLeft = e.ms / 1000;
        this.send({ type: 'callout', kind: 'stun' });
      }
    }
    if (ball.onGround) this.run = 0;
    if (dirty) this.sendStat();
  }

  private sendStat(): void {
    if (this.state) this.send({ type: 'stat', game: this.state.game, ...this.mine });
  }

  private handOff(h: Held): void {
    const b = h.ball!;
    const speed = Math.hypot(b.vx, b.vy);
    const shot = speed >= SHOT_SPEED;
    // A waiting ghost shot is spent on the first real shot.
    const ghost = shot && this.ghostReady;
    if (ghost) this.ghostReady = false;
    const msg: HandoffMsg = {
      type: 'handoff',
      ball: h.id,
      seq: h.seq + 1,
      y: b.y,
      vx: b.vx,
      vy: b.vy,
      t: Date.now(),
      by: b.by,
      fire: b.fire,
      ghost,
    };
    if (shot) {
      this.mine.shots++;
      this.mine.fastest = Math.max(this.mine.fastest, speed);
      this.sendStat();
    }
    h.seq = msg.seq;
    h.ghost = b;
    h.ghostLeft = GHOST_S;
    h.ball = null;
    h.pendingOut = { msg, lastSent: this.now() };
    this.stats.out++;
    this.send(msg);
  }

  private clear(h: Held): void {
    h.ball = null;
    h.ghost = null;
    h.remote = null;
    h.pendingOut = null;
    h.goalSent = false;
  }

  private clearAll(): void {
    for (const h of this.held.values()) this.clear(h);
  }
}
