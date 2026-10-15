import { ARENAS, spotIsFree, type ArenaKind } from '../shared/arena';
import type { Config } from '../shared/config';
import { GOAL_H } from '../shared/constants';
import {
  ARCADE,
  HAZARDS,
  HAZARD_KINDS,
  MOD_KINDS,
  POWERS,
  POWER_KINDS,
  isHazard,
  isPower,
  type HazardKind,
  type ItemKind,
  type ModKind,
  type PowerKind,
} from '../shared/effects';
import type { ArcadeState, EventMsg } from '../shared/protocol';
import { other, type Side } from '../shared/types';

/** What the director needs from the room it works for. */
export interface ArcadeHost {
  rng(): number;
  /** Length of normal time, so the frenzy can be placed at its end. */
  matchMs: number;
  /** Something the players can see has changed: send the new state. */
  changed(): void;
  event(e: EventMsg): void;
  hasExtraBall(): boolean;
  /** Drop a second ball. With no side given, it goes to whoever does not have the first. */
  extraBall(side: Side | null): void;
}

/** Which parts of Arcade this match has switched on. */
export type ArcadeRules = Pick<Config, 'keeper' | 'powerups' | 'modifiers' | 'hazards' | 'growing' | 'frenzy'>;

const ALL_ON: ArcadeRules = {
  keeper: 'normal',
  powerups: true,
  modifiers: true,
  hazards: true,
  growing: true,
  frenzy: true,
};

interface Item {
  id: number;
  half: Side;
  kind: ItemKind;
  lx: number;
  y: number;
  liveAt: number;
  expireAt: number;
}

interface Effect {
  kind: PowerKind;
  side: Side;
  by: Side;
  endAt: number;
  totalMs: number;
}

/**
 * Decides what Arcade mode puts into a game and when: growing goals,
 * power-ups, targets, hazards, modifiers, portal windows and the final frenzy.
 *
 * It runs on play time, which only advances while the ball is in play, so
 * pauses and goal celebrations never eat into a power-up or a modifier.
 */
export class Arcade {
  playMs = 0;
  goalH = GOAL_H;
  frenzy = false;
  private mod: { kind: ModKind; startAt: number; endAt: number; started: boolean } | null = null;
  private modCount = 0;
  private lastMod: ModKind | null = null;
  private lastPower: PowerKind | null = null;
  private lastHazard: HazardKind | null = null;
  private items: Item[] = [];
  private effects: Effect[] = [];
  private nextItemAt: Record<Side, number> = { A: ARCADE.itemFirstMs, B: ARCADE.itemFirstMs };
  private nextTargetAt = ARCADE.targetFirstMs;
  private nextHazardAt = ARCADE.hazardFirstMs;
  private portalsOpen = false;
  private frenzyWarned = false;
  private nextId = 1;

  constructor(
    private host: ArcadeHost,
    readonly arena: ArenaKind,
    private rules: ArcadeRules = ALL_ON,
  ) {}

  /** The modifier in force right now, if any. */
  get running(): ModKind | null {
    return this.mod?.started ? this.mod.kind : null;
  }

  private get frenzyAt(): number {
    return this.host.matchMs - ARCADE.frenzyMs;
  }

  /** Move play time on. `golden` is true once normal time is over. */
  advance(dtMs: number, golden: boolean): void {
    this.playMs += dtMs;
    const t = this.playMs;
    const rules = this.rules;
    let changed = false;

    if (rules.growing) {
      const steps = Math.floor(t / ARCADE.goalGrowEveryMs);
      const h = golden ? ARCADE.goalGoldenH : Math.min(ARCADE.goalMaxH, GOAL_H + steps * ARCADE.goalGrowBy);
      if (h !== this.goalH) {
        this.goalH = h;
        this.host.event({ type: 'event', kind: 'grow', goalH: h });
        changed = true;
      }
    }

    if (golden) {
      if (this.frenzy) {
        this.frenzy = false;
        changed = true;
      }
    } else if (rules.frenzy) {
      if (!this.frenzyWarned && t >= this.frenzyAt - ARCADE.frenzyWarnMs) {
        this.frenzyWarned = true;
        this.host.event({ type: 'event', kind: 'frenzy_soon' });
        changed = true;
      }
      if (!this.frenzy && t >= this.frenzyAt) {
        this.frenzy = true;
        this.host.event({ type: 'event', kind: 'frenzy' });
        this.host.extraBall(null);
        changed = true;
      }
    }

    if (this.mod) {
      if (!this.mod.started && t >= this.mod.startAt) {
        this.mod.started = true;
        this.host.event({ type: 'event', kind: 'mod', mod: this.mod.kind });
        changed = true;
      }
      if (t >= this.mod.endAt) {
        this.mod = null;
        changed = true;
      }
    } else {
      const warnAt = this.nextModWarnAt();
      if (warnAt !== null && t >= warnAt) {
        const kinds = MOD_KINDS.filter((k) => k !== this.lastMod);
        const kind = kinds[Math.floor(this.host.rng() * kinds.length)];
        const startAt = warnAt + ARCADE.modWarnMs;
        this.mod = { kind, startAt, endAt: startAt + ARCADE.modRunMs, started: false };
        this.lastMod = kind;
        this.modCount++;
        this.host.event({ type: 'event', kind: 'mod_soon', mod: kind });
        changed = true;
      }
    }

    if (ARENAS[this.arena].portals) {
      const open = t % ARCADE.portalCycleMs >= ARCADE.portalCycleMs - ARCADE.portalOpenMs;
      if (open !== this.portalsOpen) {
        this.portalsOpen = open;
        changed = true;
      }
    }

    if (rules.powerups) {
      // One power-up on each half at a time.
      for (const half of ['A', 'B'] as const) {
        const has = this.items.some((i) => i.half === half && isPower(i.kind));
        if (!has && t >= this.nextItemAt[half]) {
          const [lx, y] = this.freeSpot();
          this.place(half, this.pickPower(), lx, y, ARCADE.itemWarnMs, ARCADE.itemLifeMs);
          changed = true;
        }
      }

      // A bonus target appears at the same spot on both halves.
      if (t >= this.nextTargetAt) {
        this.nextTargetAt = t + ARCADE.targetEveryMs;
        const [lx, y] = this.freeSpot();
        for (const half of ['A', 'B'] as const) this.place(half, 'target', lx, y, 0, ARCADE.targetLifeMs);
        changed = true;
      }
    }

    // A hazard appears at the same spot on both halves, so it is the same problem for each player.
    if (rules.hazards && t >= this.nextHazardAt) {
      this.nextHazardAt = t + ARCADE.hazardEveryMs;
      const kinds = HAZARD_KINDS.filter((k) => k !== this.lastHazard);
      const kind = kinds[Math.floor(this.host.rng() * kinds.length)];
      this.lastHazard = kind;
      // Mud lies on the ground; the others hang in the air.
      const [lx, y] = kind === 'mud' ? [14 + this.host.rng() * 24, 0] : this.freeSpot();
      for (const half of ['A', 'B'] as const) this.place(half, kind, lx, y, ARCADE.itemWarnMs, HAZARDS[kind].lifeMs);
      changed = true;
    }

    for (const item of this.items) {
      if (t >= item.expireAt && isPower(item.kind)) this.nextItemAt[item.half] = t + this.gap();
    }
    const items = this.items.filter((i) => t < i.expireAt);
    const effects = this.effects.filter((e) => t < e.endAt);
    if (items.length !== this.items.length || effects.length !== this.effects.length) changed = true;
    this.items = items;
    this.effects = effects;

    if (changed) this.host.changed();
  }

  /** A ball on `half` touched an item; `by` kicked that ball last. */
  pickup(half: Side, id: number, by: Side): void {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.half !== half || this.playMs < item.liveAt) return;
    // Only a mine is used up by being touched; wells and mud stay for their time.
    if (isHazard(item.kind) && item.kind !== 'mine') return;
    this.items = this.items.filter((i) => i !== item);

    if (isPower(item.kind)) {
      this.nextItemAt[half] = this.playMs + this.gap();
      const info = POWERS[item.kind];
      if (info.ms > 0) {
        const side = info.on === 'me' ? by : other(by);
        // Collecting the same thing again restarts its timer.
        this.effects = this.effects.filter((e) => !(e.kind === item.kind && e.side === side));
        this.effects.push({ kind: item.kind, side, by, endAt: this.playMs + info.ms, totalMs: info.ms });
      }
      if (item.kind === 'multiball') this.host.extraBall(by);
    }
    // For a mine, `side` is whose half it went off on.
    this.host.event({ type: 'event', kind: 'pickup', side: item.kind === 'mine' ? half : by, item: item.kind });
    this.host.changed();
  }

  /** A snapshot for the players, with every time given as "from now". */
  state(): ArcadeState {
    const t = this.playMs;
    const steps = Math.floor(t / ARCADE.goalGrowEveryMs);
    const grown = !this.rules.growing || this.goalH >= ARCADE.goalMaxH;
    const warnAt = this.mod ? null : this.nextModWarnAt();
    const cycle = ARCADE.portalCycleMs;
    const openAt = cycle - ARCADE.portalOpenMs;
    const inCycle = t % cycle;
    const frenzyDue = this.rules.frenzy && !this.frenzy && t < this.frenzyAt;
    return {
      playMs: t,
      arena: this.arena,
      keeper: this.rules.keeper,
      goalH: this.goalH,
      growInMs: grown ? null : (steps + 1) * ARCADE.goalGrowEveryMs - t,
      mod: this.mod && {
        kind: this.mod.kind,
        startsInMs: Math.max(0, this.mod.startAt - t),
        leftMs: this.mod.endAt - Math.max(t, this.mod.startAt),
      },
      nextModInMs: warnAt === null ? null : Math.max(0, warnAt - t),
      frenzy: this.frenzy,
      frenzyInMs: frenzyDue ? this.frenzyAt - t : null,
      portals: ARENAS[this.arena].portals
        ? { open: this.portalsOpen, inMs: this.portalsOpen ? cycle - inCycle : openAt - inCycle }
        : null,
      items: this.items.map((i) => ({
        id: i.id,
        half: i.half,
        kind: i.kind,
        lx: i.lx,
        y: i.y,
        liveInMs: Math.max(0, i.liveAt - t),
        leftMs: i.expireAt - t,
      })),
      effects: this.effects.map((e) => ({
        kind: e.kind,
        side: e.side,
        by: e.by,
        leftMs: e.endAt - t,
        totalMs: e.totalMs,
      })),
    };
  }

  private place(half: Side, kind: ItemKind, lx: number, y: number, warnMs: number, lifeMs: number): void {
    const liveAt = this.playMs + warnMs;
    this.items.push({ id: this.nextId++, half, kind, lx, y, liveAt, expireAt: liveAt + lifeMs });
  }

  /** When the next modifier is announced, or null if there is none to come. */
  private nextModWarnAt(): number | null {
    if (!this.rules.modifiers) return null;
    const warnAt = ARCADE.modFirstWarnMs + this.modCount * ARCADE.modEveryMs;
    // Never let one run into the frenzy.
    const limit = this.rules.frenzy ? this.frenzyAt : this.host.matchMs;
    return warnAt + ARCADE.modWarnMs + ARCADE.modRunMs <= limit ? warnAt : null;
  }

  private gap(): number {
    return ARCADE.itemGapMinMs + this.host.rng() * (ARCADE.itemGapMaxMs - ARCADE.itemGapMinMs);
  }

  private pickPower(): PowerKind {
    const twoBalls = this.frenzy || this.host.hasExtraBall();
    const kinds = POWER_KINDS.filter(
      (k) =>
        k !== this.lastPower &&
        !(k === 'multiball' && twoBalls) &&
        !(k === 'nokeeper' && this.rules.keeper === 'off'),
    );
    this.lastPower = kinds[Math.floor(this.host.rng() * kinds.length)];
    return this.lastPower;
  }

  /** Somewhere in open play, clear of the arena's objects. */
  private freeSpot(): [number, number] {
    const arena = ARENAS[this.arena];
    const top = Math.min(19, arena.roof - 3);
    for (let tries = 0; ; tries++) {
      const lx = 12 + this.host.rng() * 32;
      const y = 4 + this.host.rng() * (top - 4);
      if (tries >= 16 || spotIsFree(arena, lx, y)) return [lx, y];
    }
  }
}
