var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker/index.ts
import { DurableObject } from "cloudflare:workers";

// src/shared/rules.ts
var RULES = {
  goalsToWin: 5,
  matchMs: 18e4,
  goalPauseMs: 2e3,
  countdownMs: 3e3,
  /** One player keeping the ball this long gets it taken away. */
  stallMs: 8e3,
  /** Time a missing player has to come back before forfeiting. */
  rejoinMs: 3e4,
  emptyRoomMs: 6e5,
  /** Tournament: how long a result is shown, and how long the next two players have to get ready. */
  resultMs: 6e3,
  nextTieMs: 2e4,
  /** A goal from an untouched shot at least this fast is a screamer. */
  screamerSpeed: 29
};
var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
var CODE_LENGTH = 4;
function makeCode(rng = Math.random) {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  return code;
}
__name(makeCode, "makeCode");
function parseCode(raw) {
  const code = raw.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}
__name(parseCode, "parseCode");

// src/server/connection.ts
function connect(rooms, socket, opts = {}) {
  let entry = null;
  let slot = 0;
  const send = /* @__PURE__ */ __name((m) => {
    if (socket.isOpen()) socket.send(JSON.stringify(m));
  }, "send");
  const enter = /* @__PURE__ */ __name((e, place, rejoined) => {
    entry = e;
    slot = place.slot;
    e.sends[slot] = send;
    send({ type: "joined", code: e.room.code, token: place.token, you: slot, lan: opts.lan?.() });
    e.room.sync(slot, rejoined);
    rooms.touch(e);
  }, "enter");
  const detach = /* @__PURE__ */ __name(() => {
    if (!entry) return;
    const e = entry;
    entry = null;
    if (e.sends[slot] !== send) return;
    e.sends[slot] = null;
    return e;
  }, "detach");
  return {
    onMessage(raw) {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (!m || typeof m.type !== "string") return;
      if (m.type === "create_room") {
        if (entry) return;
        const e = rooms.create(opts.code);
        enter(e, e.room.add(m), false);
      } else if (m.type === "join_room") {
        if (entry) return;
        const code = typeof m.code === "string" ? parseCode(m.code) : null;
        const e = code ? rooms.get(code) : void 0;
        if (!e) return send({ type: "error", reason: "not_found" });
        const back = typeof m.token === "string" ? e.room.rejoin(m.token) : null;
        if (back !== null) return enter(e, { slot: back, token: m.token }, true);
        const place = e.room.add(m);
        if (!place) return send({ type: "error", reason: "full" });
        enter(e, place, false);
      } else if (entry) {
        entry.room.onMessage(slot, m);
        if (m.type === "leave") {
          const e = detach();
          if (e) rooms.touch(e);
        }
      } else if (m.type === "ping") {
        send({ type: "pong", t: m.t });
      }
    },
    onClose() {
      const e = detach();
      if (!e) return;
      e.room.disconnect(slot);
      rooms.touch(e);
    }
  };
}
__name(connect, "connect");

// src/shared/constants.ts
var VIEW_H = 28;
var GROUND_MARGIN = 3;
var VIEW_TOP = VIEW_H - GROUND_MARGIN;
var ROOF_Y = 24;
var GOAL_H = 8;
var STEP_HZ = 120;
var DT = 1 / STEP_HZ;
var RESEND_MS = 500;
var tuning = {
  gravity: 15,
  ballRadius: 0.6,
  footRadius: 1,
  groundBounce: 0.6,
  wallBounce: 0.7,
  netBounce: 0.15,
  maxShot: 35,
  rollFriction: 3,
  airDrag: 0.08,
  /** Ground impacts slower than this stop the ball instead of bouncing it. */
  restSpeed: 1.2,
  /** Foot bounciness for a slow push ... */
  kickSoft: 0.15,
  /** ... rising to this for a full swipe. */
  kickHard: 0.6,
  kickSoftSpeed: 3,
  kickHardSpeed: 20,
  /** Window over which foot speed is averaged. */
  smoothMs: 50,
  sensitivity: 1
};

// src/shared/arena.ts
var NIGHT = {
  sky: ["#070a1c", "#0a0e26", "#0d1230", "#11173b", "#151c46"],
  stand: "#0d1128",
  led: "#ffb020"
};
var base = { bumpers: [], movers: [], pads: [], portals: null, spinner: null, blocks: [], roof: ROOF_Y, palette: NIGHT };
var ARENAS = {
  none: { ...base, name: "STADIUM", text: "NOTHING BUT THE PITCH" },
  pinball: {
    ...base,
    name: "PINBALL PARK",
    text: "BUMPERS KICK THE BALL AWAY",
    bumpers: [
      { x: 27, y: 15, r: 1.3 },
      { x: 36, y: 6, r: 1.3 }
    ],
    palette: { sky: ["#12061f", "#1a0a2e", "#230f3d", "#2c134b", "#36185a"], stand: "#160a26", led: "#ff5fd2" }
  },
  springs: {
    ...base,
    name: "SPRING GARDEN",
    text: "THE TRAMPOLINE THROWS IT UP",
    bumpers: [{ x: 33, y: 15, r: 1.3 }],
    pads: [[20, 26]],
    palette: { sky: ["#04161a", "#062026", "#082b32", "#0b363e", "#0e424b"], stand: "#07181c", led: "#5fe0a0" }
  },
  portals: {
    ...base,
    name: "PORTAL LAB",
    text: "IN ONE RING, OUT THE OTHER",
    portals: [
      { x: 44, y: 4.5, r: 1.9 },
      { x: 15, y: 17, r: 1.9 }
    ],
    palette: { sky: ["#0b0620", "#120a30", "#190e40", "#201250", "#281660"], stand: "#0f0a26", led: "#c77dff" }
  },
  windmill: {
    ...base,
    name: "WINDMILL",
    text: "TIME YOUR SHOT PAST THE BAR",
    spinner: { x: 30, y: 12, len: 11, speed: 1.5, thick: 0.45 },
    palette: { sky: ["#1a0d12", "#27131a", "#341a22", "#42222a", "#502a32"], stand: "#1c1014", led: "#ffb347" }
  },
  crusher: {
    ...base,
    name: "CRUSHER",
    text: "THE BUMPERS NEVER STOP",
    movers: [
      { x: 24, y: 12, r: 1.4, amp: 7, period: 4, phase: 0 },
      { x: 36, y: 12, r: 1.4, amp: 7, period: 4, phase: 0.5 }
    ],
    palette: { sky: ["#160606", "#210a0a", "#2c0e0e", "#381212", "#441616"], stand: "#180a0a", led: "#ff5c5c" }
  },
  pillars: {
    ...base,
    name: "THE PILLARS",
    text: "GO OVER OR GO BETWEEN",
    blocks: [
      { x0: 20, y0: 0, x1: 22, y1: 6 },
      { x0: 30, y0: 0, x1: 32, y1: 9 }
    ],
    palette: { sky: ["#17120a", "#221a0e", "#2d2312", "#392c16", "#45351a"], stand: "#19140c", led: "#ffd23f" }
  },
  lowroof: {
    ...base,
    name: "LOW ROOF",
    text: "KEEP IT FAST AND FLAT",
    roof: 13,
    blocks: [
      { x0: 16, y0: 10, x1: 18, y1: 13 },
      { x0: 27, y0: 9, x1: 29, y1: 13 }
    ],
    palette: { sky: ["#0b0f14", "#10161d", "#151d26", "#1a242f", "#1f2b38"], stand: "#0e1319", led: "#8fd3ff" }
  }
};
var ARCADE_ARENAS = Object.keys(ARENAS).filter((k) => k !== "none");
function spotIsFree(arena, x, y) {
  if (y > arena.roof - 2.5) return false;
  for (const b of [...arena.bumpers, ...arena.portals ?? []]) if (Math.hypot(b.x - x, b.y - y) < b.r + 3) return false;
  for (const m of arena.movers) if (Math.abs(m.x - x) < m.r + 3) return false;
  const s = arena.spinner;
  if (s && Math.hypot(s.x - x, s.y - y) < s.len / 2 + 2) return false;
  for (const k of arena.blocks) if (x > k.x0 - 2.5 && x < k.x1 + 2.5 && y > k.y0 - 2.5 && y < k.y1 + 2.5) return false;
  return true;
}
__name(spotIsFree, "spotIsFree");

// src/shared/bracket.ts
var ORDER = {
  2: [0, 1],
  4: [0, 3, 1, 2],
  8: [0, 7, 3, 4, 1, 6, 2, 5]
};
var tie = /* @__PURE__ */ __name(() => ({ a: null, b: null, winner: null, score: null, done: false }), "tie");
function makeBracket(ids, rng = Math.random) {
  const drawn = [...ids];
  for (let i = drawn.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [drawn[i], drawn[j]] = [drawn[j], drawn[i]];
  }
  const size = drawn.length <= 2 ? 2 : drawn.length <= 4 ? 4 : 8;
  const order = ORDER[size];
  const rounds = [];
  for (let n = size / 2; n >= 1; n /= 2) rounds.push(Array.from({ length: n }, tie));
  rounds[0].forEach((t, i) => {
    t.a = drawn[order[i * 2]] ?? null;
    t.b = drawn[order[i * 2 + 1]] ?? null;
  });
  settle(rounds);
  return rounds;
}
__name(makeBracket, "makeBracket");
function settle(rounds) {
  rounds.forEach((round, r) => {
    round.forEach((t, i) => {
      if (t.done) return;
      if (r > 0) {
        const fa = rounds[r - 1][i * 2];
        const fb = rounds[r - 1][i * 2 + 1];
        t.a = fa.winner;
        t.b = fb.winner;
        if (!fa.done || !fb.done) return;
      }
      if (t.a === null || t.b === null) {
        t.winner = t.a ?? t.b;
        t.done = true;
      }
    });
  });
}
__name(settle, "settle");
function nextTie(rounds) {
  for (let r = 0; r < rounds.length; r++) {
    const i = rounds[r].findIndex((t) => !t.done && t.a !== null && t.b !== null);
    if (i >= 0) return [r, i];
  }
  return null;
}
__name(nextTie, "nextTie");
function report(rounds, at, winner, score) {
  const t = rounds[at[0]][at[1]];
  t.winner = winner;
  t.score = score;
  t.done = true;
  settle(rounds);
}
__name(report, "report");
function withdraw(rounds, id) {
  for (const round of rounds) {
    for (const t of round) {
      if (t.done) continue;
      if (t.a === id) t.a = null;
      if (t.b === id) t.b = null;
    }
  }
  for (const round of rounds) for (const t of round) if (t.done && t.winner === id && t !== rounds.at(-1)[0]) t.winner = null;
  settle(rounds);
}
__name(withdraw, "withdraw");
function champion(rounds) {
  const final = rounds.at(-1)[0];
  return final.done ? final.winner : null;
}
__name(champion, "champion");

// src/shared/config.ts
var MINUTES = [1, 2, 3, 5];
var GOALS = [3, 5, 7, 10];
var KEEPER_LEVELS = ["off", "easy", "normal", "hard"];
var ARENA_CHOICES = ["random", ...Object.keys(ARENAS)];
var SWITCHES = ["powerups", "modifiers", "hazards", "growing", "frenzy"];
var PRESETS = {
  arcade: {
    preset: "arcade",
    minutes: 3,
    goals: 5,
    series: 1,
    arena: "random",
    keeper: "normal",
    powerups: true,
    modifiers: true,
    hazards: true,
    growing: true,
    frenzy: true
  },
  classic: {
    preset: "classic",
    minutes: 3,
    goals: 5,
    series: 1,
    arena: "none",
    keeper: "off",
    powerups: false,
    modifiers: false,
    hazards: false,
    growing: false,
    frenzy: false
  }
};
function usesArcade(c) {
  return c.arena !== "none" || c.keeper !== "off" || SWITCHES.some((k) => c[k]);
}
__name(usesArcade, "usesArcade");
function patchConfig(c, patch) {
  if (patch.preset === "arcade" || patch.preset === "classic") return { ...PRESETS[patch.preset], series: c.series };
  const next = { ...c };
  if (MINUTES.includes(patch.minutes)) next.minutes = patch.minutes;
  if (GOALS.includes(patch.goals)) next.goals = patch.goals;
  if (patch.series === 1 || patch.series === 3) next.series = patch.series;
  if (ARENA_CHOICES.includes(patch.arena)) next.arena = patch.arena;
  if (KEEPER_LEVELS.includes(patch.keeper)) next.keeper = patch.keeper;
  for (const k of SWITCHES) if (typeof patch[k] === "boolean") next[k] = patch[k];
  const same = Object.keys(next).every((k) => k === "series" || next[k] === c[k]);
  if (!same) next.preset = "custom";
  return next;
}
__name(patchConfig, "patchConfig");
var NAME_MAX = 10;
function cleanName(raw) {
  const name = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim();
  return name || "PLAYER";
}
__name(cleanName, "cleanName");
var EMOTES = ["NICE!", "WOW!", "OOPS", "GG", "HAHA", "LUCKY!"];
var EMOTE_GAP_MS = 2e3;

// src/shared/effects.ts
var ARCADE = {
  goalGrowEveryMs: 3e4,
  goalGrowBy: 1.5,
  goalMaxH: 15.5,
  goalGoldenH: 18,
  /** A power-up is shown this long before it can be collected. */
  itemWarnMs: 3e3,
  itemFirstMs: 5e3,
  itemGapMinMs: 12e3,
  itemGapMaxMs: 18e3,
  itemLifeMs: 2e4,
  itemRadius: 1.3,
  targetFirstMs: 2e4,
  targetEveryMs: 25e3,
  targetLifeMs: 8e3,
  modFirstWarnMs: 1e4,
  modEveryMs: 3e4,
  modWarnMs: 5e3,
  modRunMs: 2e4,
  windAccel: 7,
  portalCycleMs: 35e3,
  portalOpenMs: 1e4,
  /** The frenzy covers this much of the end of normal time. */
  frenzyMs: 3e4,
  frenzyWarnMs: 5e3,
  /** A fireball flies this much faster than the normal cap. */
  fireMult: 1.4,
  fireStunMs: 600,
  /** Blocking a shot at this share of the cap or more stuns the boot. */
  stunAt: 0.9,
  stunMs: 400,
  meterJuggle: 0.08,
  meterCushion: 0.1,
  meterSave: 0.35,
  meterTarget: 0.5,
  meterPerSecond: 0.01,
  hazardFirstMs: 14e3,
  hazardEveryMs: 25e3,
  /** A mine throws the ball out at a speed between these. */
  mineSpeedMin: 26,
  mineSpeedMax: 34,
  mineStunRange: 4,
  mineStunMs: 500,
  wellRange: 9,
  wellPull: 26,
  /** Rolling friction is multiplied by this in mud. */
  mudFriction: 8,
  mudHalfWidth: 3,
  /** A fireball knocks the keeper out for this long. */
  keeperStunMs: 1500,
  magnetRange: 4,
  magnetPull: 28,
  bigGoalMult: 1.5
};
var POWERS = {
  giant: { name: "GIANT BOOT", text: "A HUGE BOOT FOR 8 SECONDS", ms: 8e3, on: "me" },
  shrink: { name: "SHRINK", text: "THE OTHER BOOT IS TINY FOR 8 SECONDS", ms: 8e3, on: "them" },
  freeze: { name: "FREEZE", text: "THE OTHER BOOT IS FROZEN FOR 2 SECONDS", ms: 2e3, on: "them" },
  fireball: { name: "FIREBALL", text: "SUPER METER FULL: SHOOT HARD", ms: 0, on: "me" },
  multiball: { name: "MULTIBALL", text: "A SECOND BALL DROPS IN", ms: 0, on: "me" },
  biggoal: { name: "BIG GOAL", text: "THE OTHER GOAL IS TALLER FOR 10 SECONDS", ms: 1e4, on: "them" },
  ghost: { name: "GHOST BALL", text: "THE NEXT SHOT CANNOT BE SEEN COMING", ms: 0, on: "me" },
  magnet: { name: "MAGNET", text: "THE BALL IS DRAWN TO THE BOOT FOR 8 SECONDS", ms: 8e3, on: "me" },
  nokeeper: { name: "KEEPER OFF", text: "THE OTHER KEEPER LEAVES FOR 6 SECONDS", ms: 6e3, on: "them" }
};
var POWER_KINDS = Object.keys(POWERS);
var HAZARDS = {
  mine: { name: "MINE", text: "IT THROWS THE BALL ANYWHERE", lifeMs: 12e3 },
  well: { name: "GRAVITY WELL", text: "IT DRAGS THE BALL IN", lifeMs: 8e3 },
  mud: { name: "MUD", text: "THE BALL STOPS DEAD", lifeMs: 1e4 }
};
var HAZARD_KINDS = Object.keys(HAZARDS);
var isHazard = /* @__PURE__ */ __name((k) => k in HAZARDS, "isHazard");
var isPower = /* @__PURE__ */ __name((k) => k in POWERS, "isPower");
var MODS = {
  lowgrav: { name: "LOW GRAVITY", text: "THE BALL FLOATS" },
  bigball: { name: "BIG BALL", text: "HARD TO MISS, HARD TO STOP" },
  tinyball: { name: "TINY BALL", text: "SMALL AND SLIPPERY" },
  wind: { name: "CROSSWIND", text: "IT TURNS HALFWAY THROUGH" },
  icy: { name: "ICY PITCH", text: "THE BALL SLIDES FOREVER" },
  turbo: { name: "TURBO", text: "EVERYTHING FLIES FASTER" }
};
var MOD_KINDS = Object.keys(MODS);
function speedLimitScale(mod, fire) {
  return (mod === "turbo" ? 1.3 : 1) * (fire ? ARCADE.fireMult : 1);
}
__name(speedLimitScale, "speedLimitScale");

// src/shared/protocol.ts
var ROOM_MAX = 8;

// src/shared/types.ts
var other = /* @__PURE__ */ __name((s) => s === "A" ? "B" : "A", "other");

// src/server/arcade.ts
var ALL_ON = {
  keeper: "normal",
  powerups: true,
  modifiers: true,
  hazards: true,
  growing: true,
  frenzy: true
};
var Arcade = class {
  constructor(host, arena, rules = ALL_ON) {
    this.host = host;
    this.arena = arena;
    this.rules = rules;
  }
  host;
  arena;
  rules;
  static {
    __name(this, "Arcade");
  }
  playMs = 0;
  goalH = GOAL_H;
  frenzy = false;
  mod = null;
  modCount = 0;
  lastMod = null;
  lastPower = null;
  lastHazard = null;
  items = [];
  effects = [];
  nextItemAt = { A: ARCADE.itemFirstMs, B: ARCADE.itemFirstMs };
  nextTargetAt = ARCADE.targetFirstMs;
  nextHazardAt = ARCADE.hazardFirstMs;
  portalsOpen = false;
  frenzyWarned = false;
  nextId = 1;
  /** The modifier in force right now, if any. */
  get running() {
    return this.mod?.started ? this.mod.kind : null;
  }
  get frenzyAt() {
    return this.host.matchMs - ARCADE.frenzyMs;
  }
  /** Move play time on. `golden` is true once normal time is over. */
  advance(dtMs, golden) {
    this.playMs += dtMs;
    const t = this.playMs;
    const rules = this.rules;
    let changed = false;
    if (rules.growing) {
      const steps = Math.floor(t / ARCADE.goalGrowEveryMs);
      const h = golden ? ARCADE.goalGoldenH : Math.min(ARCADE.goalMaxH, GOAL_H + steps * ARCADE.goalGrowBy);
      if (h !== this.goalH) {
        this.goalH = h;
        this.host.event({ type: "event", kind: "grow", goalH: h });
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
        this.host.event({ type: "event", kind: "frenzy_soon" });
        changed = true;
      }
      if (!this.frenzy && t >= this.frenzyAt) {
        this.frenzy = true;
        this.host.event({ type: "event", kind: "frenzy" });
        this.host.extraBall(null);
        changed = true;
      }
    }
    if (this.mod) {
      if (!this.mod.started && t >= this.mod.startAt) {
        this.mod.started = true;
        this.host.event({ type: "event", kind: "mod", mod: this.mod.kind });
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
        this.host.event({ type: "event", kind: "mod_soon", mod: kind });
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
      for (const half of ["A", "B"]) {
        const has = this.items.some((i) => i.half === half && isPower(i.kind));
        if (!has && t >= this.nextItemAt[half]) {
          const [lx, y] = this.freeSpot();
          this.place(half, this.pickPower(), lx, y, ARCADE.itemWarnMs, ARCADE.itemLifeMs);
          changed = true;
        }
      }
      if (t >= this.nextTargetAt) {
        this.nextTargetAt = t + ARCADE.targetEveryMs;
        const [lx, y] = this.freeSpot();
        for (const half of ["A", "B"]) this.place(half, "target", lx, y, 0, ARCADE.targetLifeMs);
        changed = true;
      }
    }
    if (rules.hazards && t >= this.nextHazardAt) {
      this.nextHazardAt = t + ARCADE.hazardEveryMs;
      const kinds = HAZARD_KINDS.filter((k) => k !== this.lastHazard);
      const kind = kinds[Math.floor(this.host.rng() * kinds.length)];
      this.lastHazard = kind;
      const [lx, y] = kind === "mud" ? [14 + this.host.rng() * 24, 0] : this.freeSpot();
      for (const half of ["A", "B"]) this.place(half, kind, lx, y, ARCADE.itemWarnMs, HAZARDS[kind].lifeMs);
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
  pickup(half, id, by) {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.half !== half || this.playMs < item.liveAt) return;
    if (isHazard(item.kind) && item.kind !== "mine") return;
    this.items = this.items.filter((i) => i !== item);
    if (isPower(item.kind)) {
      this.nextItemAt[half] = this.playMs + this.gap();
      const info = POWERS[item.kind];
      if (info.ms > 0) {
        const side = info.on === "me" ? by : other(by);
        this.effects = this.effects.filter((e) => !(e.kind === item.kind && e.side === side));
        this.effects.push({ kind: item.kind, side, by, endAt: this.playMs + info.ms, totalMs: info.ms });
      }
      if (item.kind === "multiball") this.host.extraBall(by);
    }
    this.host.event({ type: "event", kind: "pickup", side: item.kind === "mine" ? half : by, item: item.kind });
    this.host.changed();
  }
  /** A snapshot for the players, with every time given as "from now". */
  state() {
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
        leftMs: this.mod.endAt - Math.max(t, this.mod.startAt)
      },
      nextModInMs: warnAt === null ? null : Math.max(0, warnAt - t),
      frenzy: this.frenzy,
      frenzyInMs: frenzyDue ? this.frenzyAt - t : null,
      portals: ARENAS[this.arena].portals ? { open: this.portalsOpen, inMs: this.portalsOpen ? cycle - inCycle : openAt - inCycle } : null,
      items: this.items.map((i) => ({
        id: i.id,
        half: i.half,
        kind: i.kind,
        lx: i.lx,
        y: i.y,
        liveInMs: Math.max(0, i.liveAt - t),
        leftMs: i.expireAt - t
      })),
      effects: this.effects.map((e) => ({
        kind: e.kind,
        side: e.side,
        by: e.by,
        leftMs: e.endAt - t,
        totalMs: e.totalMs
      }))
    };
  }
  place(half, kind, lx, y, warnMs, lifeMs) {
    const liveAt = this.playMs + warnMs;
    this.items.push({ id: this.nextId++, half, kind, lx, y, liveAt, expireAt: liveAt + lifeMs });
  }
  /** When the next modifier is announced, or null if there is none to come. */
  nextModWarnAt() {
    if (!this.rules.modifiers) return null;
    const warnAt = ARCADE.modFirstWarnMs + this.modCount * ARCADE.modEveryMs;
    const limit = this.rules.frenzy ? this.frenzyAt : this.host.matchMs;
    return warnAt + ARCADE.modWarnMs + ARCADE.modRunMs <= limit ? warnAt : null;
  }
  gap() {
    return ARCADE.itemGapMinMs + this.host.rng() * (ARCADE.itemGapMaxMs - ARCADE.itemGapMinMs);
  }
  pickPower() {
    const twoBalls = this.frenzy || this.host.hasExtraBall();
    const kinds = POWER_KINDS.filter(
      (k) => k !== this.lastPower && !(k === "multiball" && twoBalls) && !(k === "nokeeper" && this.rules.keeper === "off")
    );
    this.lastPower = kinds[Math.floor(this.host.rng() * kinds.length)];
    return this.lastPower;
  }
  /** Somewhere in open play, clear of the arena's objects. */
  freeSpot() {
    const arena = ARENAS[this.arena];
    const top = Math.min(19, arena.roof - 3);
    for (let tries = 0; ; tries++) {
      const lx = 12 + this.host.rng() * 32;
      const y = 4 + this.host.rng() * (top - 4);
      if (tries >= 16 || spotIsFree(arena, lx, y)) return [lx, y];
    }
  }
};

// src/server/relay.ts
var BallRelay = class {
  constructor(send, opts = {}, id = 0) {
    this.send = send;
    this.id = id;
    this.resendMs = opts.resendMs ?? RESEND_MS;
    this.maxSpeed = opts.maxSpeed ?? tuning.maxShot;
  }
  send;
  id;
  static {
    __name(this, "BallRelay");
  }
  owner = "A";
  seq = 0;
  /** False until spawned, and again once the ball is dead. */
  alive = false;
  stats = { resends: 0, rejected: 0 };
  onOwnerChange = null;
  /** How far above the normal cap this handoff may be (fireball, Turbo). */
  speedScale = /* @__PURE__ */ __name(() => 1, "speedScale");
  pending = null;
  resendMs;
  maxSpeed;
  /** Give a fresh ball to one side. The new sequence number makes any message about the old ball stale. */
  spawn(side) {
    this.kill();
    this.alive = true;
    this.owner = side;
    this.send(side, { type: "spawn", ball: this.id, seq: this.seq });
    this.onOwnerChange?.();
  }
  /** Take the ball off the pitch. */
  take() {
    const from = this.owner;
    this.kill();
    this.send(from, { type: "take_ball", ball: this.id });
  }
  /** The current ball is dead: nothing more about it will be accepted. */
  kill() {
    this.clearPending();
    this.alive = false;
    this.seq++;
  }
  /** Repeat an unconfirmed handoff to a receiver who has just come back. */
  resendTo(side) {
    if (!this.pending || this.pending.to !== side) return false;
    this.send(side, this.pending.msg);
    return true;
  }
  onHandoff(side, m) {
    if (!this.alive) return;
    if (side === this.owner && m.seq === this.seq + 1) {
      if (!this.valid(m)) {
        this.stats.rejected++;
        this.spawn(side);
        return;
      }
      this.clearPending();
      this.seq = m.seq;
      this.owner = other(side);
      this.send(side, { type: "handoff_ok", ball: this.id, seq: m.seq });
      const to = this.owner;
      const msg = {
        type: "handoff",
        ball: this.id,
        seq: m.seq,
        y: m.y,
        vx: m.vx,
        vy: m.vy,
        t: m.t,
        by: m.by === "A" || m.by === "B" ? m.by : null,
        fire: !!m.fire,
        ghost: !!m.ghost
      };
      this.send(to, msg);
      const timer = setInterval(() => {
        this.stats.resends++;
        this.send(to, msg);
      }, this.resendMs);
      this.pending = { to, msg, timer };
      this.onOwnerChange?.();
    } else if (side !== this.owner && m.seq === this.seq) {
      this.send(side, { type: "handoff_ok", ball: this.id, seq: m.seq });
    } else if (m.seq > this.seq) {
      this.send(side, { type: "drop_ball", ball: this.id, seq: this.seq });
    }
  }
  onAck(side, seq) {
    if (this.pending && this.pending.to === side && this.pending.msg.seq === seq) this.clearPending();
  }
  onPreview(side, m) {
    if (this.alive && side === this.owner) this.send(other(side), { ...m, ball: this.id });
  }
  close() {
    this.clearPending();
  }
  valid(m) {
    if (![m.y, m.vx, m.vy].every(Number.isFinite)) return false;
    if (Math.hypot(m.vx, m.vy) > this.maxSpeed * this.speedScale(m) * 1.02 + 0.5) return false;
    return m.y >= 0 && m.y <= ROOF_Y;
  }
  clearPending() {
    if (!this.pending) return;
    clearInterval(this.pending.timer);
    this.pending = null;
  }
};

// src/server/room.ts
var noStats = /* @__PURE__ */ __name(() => ({
  A: { shots: 0, fastest: 0, saves: 0, juggle: 0, keeper: 0 },
  B: { shots: 0, fastest: 0, saves: 0, juggle: 0, keeper: 0 }
}), "noStats");
var ARCADE_TICK_MS = 200;
var SEATS = { 1: ["A1", "B1"], 2: ["A1", "B1", "A2", "B2"] };
var sideOf = /* @__PURE__ */ __name((seat) => seat ? seat[0] : null, "sideOf");
var Room = class {
  constructor(code, sendSlot, opts = {}) {
    this.code = code;
    this.sendSlot = sendSlot;
    this.overrides = opts.rules ?? {};
    this.rng = opts.rng ?? Math.random;
    const relay = /* @__PURE__ */ __name((id) => {
      const r = new BallRelay((to, m) => this.sendSide(to, m), opts, id);
      r.speedScale = (m) => speedLimitScale(this.arcade?.running ?? null, !!m.fire);
      return r;
    }, "relay");
    this.relays = [relay(0), relay(1)];
    this.relay.onOwnerChange = () => {
      this.tallyPossession();
      if (this.phase === "playing") {
        this.startPossession();
        this.armStall();
      }
    };
  }
  code;
  sendSlot;
  static {
    __name(this, "Room");
  }
  /** Members by id; a gap is null. */
  players = [];
  /** Who sets the rules. */
  host = 0;
  /** The match rules, set by the host in the lobby. */
  config = { ...PRESETS.arcade };
  team = 1;
  format = "match";
  phase = "lobby";
  score = { A: 0, B: 0 };
  seriesScore = { A: 0, B: 0 };
  game = 0;
  golden = false;
  kickoff = "A";
  /** One relay per ball. The second ball only exists in Arcade mode. */
  relays;
  arcade = null;
  /** The tournament in progress, if there is one. */
  bracket = null;
  tieAt = null;
  bracketNames = {};
  nextTieAt = 0;
  bracketTimer = null;
  /** Rule values forced by tests and the soak run, on top of the config. */
  overrides;
  rng;
  remainingMs = 0;
  clockSince = null;
  clockTimer = null;
  minuteTimer = null;
  phaseTimer = null;
  stallTimer = null;
  forfeitTimer = null;
  arcadeTimer = null;
  arcadeAt = 0;
  forfeitAt = 0;
  next = "kickoff";
  timerMs = 0;
  everPlayed = false;
  seriesDone = false;
  matchPointSaid = { A: false, B: false };
  reported = noStats();
  possession = { A: 0, B: 0 };
  possSince = null;
  possSide = "A";
  lastFullTime = null;
  /** The numbers the referee works to: defaults, then the lobby's choices, then any test overrides. */
  get rules() {
    return {
      ...RULES,
      matchMs: this.config.minutes * 6e4,
      goalsToWin: this.config.goals,
      ...this.overrides
    };
  }
  /** The main ball. */
  get relay() {
    return this.relays[0];
  }
  get empty() {
    return !this.players.some((p) => p?.connected);
  }
  at(seat) {
    return this.players.find((p) => p?.seat === seat) ?? null;
  }
  idOf(p) {
    return this.players.indexOf(p);
  }
  sit(p, seat) {
    p.seat = seat;
    p.side = sideOf(seat);
    p.ready = false;
  }
  /** The players on the pitch. */
  get seated() {
    return this.players.filter((p) => !!p?.seat);
  }
  /** Reserve a place for someone new. Call `sync` once their socket is ready. */
  add(who = {}) {
    if (this.players.filter(Boolean).length >= ROOM_MAX) return null;
    let slot = this.players.findIndex((p) => !p);
    if (slot < 0) slot = this.players.length;
    const open = (this.phase === "lobby" || this.phase === "full_time") && !this.bracket && !who.watch;
    const seat = open ? SEATS[this.team].find((s) => !this.at(s)) ?? null : null;
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
      watch: !!who.watch
    };
    return { slot, token };
  }
  /** Someone who dropped out returns with the token they were given. */
  rejoin(token) {
    const slot = this.players.findIndex((p2) => p2?.token === token);
    if (slot < 0) return null;
    const p = this.players[slot];
    p.connected = true;
    p.away = false;
    return slot;
  }
  /** Bring a newly attached socket up to date, and resume if everyone is back. */
  sync(slot, rejoined = false) {
    this.broadcastRoom();
    this.sendSlot(slot, this.matchState());
    if (this.phase === "full_time" && this.lastFullTime) this.sendSlot(slot, this.lastFullTime);
    const p = this.players[slot];
    if (rejoined && p?.side && p.seat?.endsWith("1")) {
      const side = p.side;
      const lost = /* @__PURE__ */ __name((r) => r.alive && !r.resendTo(side) && r.owner === side, "lost");
      if (lost(this.relays[1])) this.relays[1].kill();
      if (lost(this.relay)) {
        if (this.phase === "paused" && this.next === "continue") {
          this.next = "kickoff";
          this.kickoff = side;
        } else if (this.phase === "playing") {
          this.relay.spawn(side);
        }
      }
    }
    this.maybeResume();
  }
  disconnect(slot) {
    const p = this.players[slot];
    if (!p) return;
    if (!p.seat || this.phase === "lobby" || this.phase === "full_time") {
      this.remove(slot);
    } else if (this.handOver(p)) {
      p.connected = false;
      this.broadcastRoom();
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
  handOver(p) {
    const side = p.side;
    const mate = this.seated.find((q) => q !== p && q.side === side && q.connected);
    if (!mate) return false;
    const wasRunner = p.seat.endsWith("1");
    this.sit(p, null);
    if (wasRunner) {
      mate.seat = `${side}1`;
      if (this.phase === "playing") {
        for (const r of this.relays) if (r.alive && r.owner === side) r.spawn(side);
      } else if (this.next === "continue" && this.relay.owner === side) {
        this.next = "kickoff";
        this.kickoff = side;
      }
    }
    return true;
  }
  onMessage(slot, m) {
    const p = this.players[slot];
    if (!p) return;
    const side = p.side;
    const lobby = this.phase === "lobby" && !this.bracket;
    const runs = !!p.seat?.endsWith("1");
    switch (m.type) {
      case "set_side":
        if (m.side === "A" || m.side === "B") this.takeSeat(p, `${m.side}1`, lobby);
        break;
      case "set_seat":
        if (m.seat === null) {
          if (lobby) {
            this.sit(p, null);
            this.broadcastRoom();
          }
        } else if (SEATS[this.team].includes(m.seat)) {
          this.takeSeat(p, m.seat, lobby);
        }
        break;
      case "set_team":
        if (!lobby || slot !== this.host || m.size !== 1 && m.size !== 2) break;
        this.team = m.size;
        for (const q of this.seated) if (!SEATS[this.team].includes(q.seat)) this.sit(q, null);
        this.broadcastRoom();
        break;
      case "set_format":
        if (!lobby || slot !== this.host || m.format !== "match" && m.format !== "tournament") break;
        this.format = m.format;
        this.broadcastRoom();
        break;
      case "start_tournament":
        if (lobby && slot === this.host && this.format === "tournament") this.startTournament();
        break;
      case "end_tournament":
        if (slot === this.host && this.bracket && (this.phase === "lobby" || this.phase === "full_time")) {
          this.endTournament();
        }
        break;
      case "set_config":
        if (!lobby || slot !== this.host || !m.patch || typeof m.patch !== "object") break;
        this.config = patchConfig(this.config, m.patch);
        this.broadcastRoom();
        break;
      case "emote": {
        const now = Date.now();
        if (!(m.id >= 0 && m.id < EMOTES.length) || now - p.emoteAt < EMOTE_GAP_MS) break;
        p.emoteAt = now;
        this.broadcast({ type: "emote", side, name: p.name, id: m.id | 0 });
        break;
      }
      case "ready":
        if (!p.seat || this.phase !== "lobby" && this.phase !== "full_time") break;
        if (this.bracket && this.phase === "full_time") break;
        p.ready = !!m.ready;
        this.broadcastRoom();
        this.maybeStart();
        break;
      case "leave":
        if (!p.seat || this.phase === "lobby" || this.phase === "full_time") {
          this.remove(slot);
        } else if (this.handOver(p)) {
          this.remove(slot);
          this.maybeResume();
        } else {
          p.connected = false;
          this.finishGame(other(side), true);
        }
        break;
      case "away":
        if (!p.seat) break;
        p.away = !!m.away;
        if (p.away) this.pause();
        else this.maybeResume();
        break;
      case "goal":
        if (side && runs) this.onGoal(side, this.relayFor(m.ball), m.seq, m.speed, m.clean);
        break;
      case "stat":
        if (!side || !runs || m.game !== this.game) break;
        this.reported[side] = {
          shots: Math.max(0, m.shots | 0),
          fastest: Number.isFinite(m.fastest) ? Math.max(0, m.fastest) : 0,
          saves: Math.max(0, m.saves | 0),
          juggle: Math.max(0, m.juggle | 0),
          keeper: Math.max(0, (m.keeper ?? 0) | 0)
        };
        break;
      case "callout":
        if (side && this.phase === "playing" && ["save", "bar", "fire", "stun", "keeper"].includes(m.kind)) {
          this.broadcast({ type: "event", kind: m.kind, side });
        }
        break;
      case "pickup":
        if (side && runs && this.phase === "playing" && (m.by === "A" || m.by === "B")) {
          this.arcade?.pickup(side, m.id, m.by);
        }
        break;
      case "meter":
        if (side && runs && Number.isFinite(m.v)) {
          this.sendSide(other(side), { type: "meter", side, v: Math.min(1, Math.max(0, m.v)), ghost: !!m.ghost });
        }
        break;
      case "foot":
        if (side && !runs && Number.isFinite(m.x) && Number.isFinite(m.y)) {
          this.sendSide(side, { type: "foot", x: m.x, y: m.y });
        }
        break;
      case "view":
        if (side && runs) this.relayView(p, side, m);
        break;
      case "handoff":
        if (side && runs && (this.phase === "playing" || this.phase === "paused")) {
          this.relayFor(m.ball)?.onHandoff(side, m);
        }
        break;
      case "handoff_ack":
        if (side && runs) this.relayFor(m.ball)?.onAck(side, m.seq);
        break;
      case "ball_preview":
        if (side && runs && this.phase === "playing") this.relayFor(m.ball)?.onPreview(side, m);
        break;
      case "ping":
        this.sendSlot(slot, { type: "pong", t: m.t });
        break;
    }
  }
  /** Drop the second ball, unless it is already in play. */
  spawnExtraBall(side) {
    if (this.phase !== "playing" || this.relays[1].alive) return;
    this.relays[1].spawn(side ?? other(this.relay.owner));
  }
  close() {
    this.stopTimers();
    if (this.bracketTimer) clearTimeout(this.bracketTimer);
    for (const r of this.relays) r.close();
  }
  relayFor(ball) {
    return this.relays[ball ?? 0];
  }
  /** Take a seat. An occupied one can only be had by swapping with its holder. */
  takeSeat(p, seat, lobby) {
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
  relayView(from, side, m) {
    if (!Array.isArray(m.balls) || !Array.isArray(m.feet)) return;
    const out = { ...m, type: "view", side };
    this.players.forEach((q, id) => {
      if (q && q !== from && q.connected && (!q.seat || q.side === side)) this.sendSlot(id, out);
    });
  }
  // --- match flow ---
  maybeStart() {
    const needed = SEATS[this.team].map((s) => this.at(s));
    if (needed.every((q) => q?.ready && q.connected)) this.startGame();
  }
  startGame() {
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
    this.kickoff = this.everPlayed ? other(this.kickoff) : this.rng() < 0.5 ? "A" : "B";
    this.everPlayed = true;
    const arena = this.config.arena === "random" ? ARCADE_ARENAS[Math.floor(this.rng() * ARCADE_ARENAS.length)] : this.config.arena;
    this.arcade = usesArcade(this.config) ? new Arcade(
      {
        rng: this.rng,
        matchMs: this.rules.matchMs,
        changed: /* @__PURE__ */ __name(() => this.broadcastMatch(), "changed"),
        event: /* @__PURE__ */ __name((e) => this.broadcast(e), "event"),
        hasExtraBall: /* @__PURE__ */ __name(() => this.relays[1].alive, "hasExtraBall"),
        extraBall: /* @__PURE__ */ __name((side) => this.spawnExtraBall(side), "extraBall")
      },
      arena,
      this.config
    ) : null;
    for (const p of this.players) if (p) p.ready = false;
    this.broadcastRoom();
    this.countdown("kickoff");
  }
  countdown(next) {
    this.phase = "countdown";
    this.next = next;
    this.timerMs = this.rules.countdownMs;
    this.phaseTimer = setTimeout(() => this.runNext(), this.rules.countdownMs);
    this.broadcastMatch();
  }
  runNext() {
    this.phaseTimer = null;
    if (this.next === "end") {
      this.finishGame(this.score.A > this.score.B ? "A" : "B", false);
      return;
    }
    this.phase = "playing";
    this.startClock();
    this.broadcastMatch();
    if (this.next === "kickoff") {
      this.relay.spawn(this.kickoff);
      if (this.arcade?.frenzy) this.spawnExtraBall(null);
      for (const s of ["A", "B"]) {
        if (this.score[s] >= this.rules.goalsToWin - 1 && !this.matchPointSaid[s]) {
          this.matchPointSaid[s] = true;
          this.broadcast({ type: "event", kind: "match_point", side: s });
        }
      }
    }
  }
  onGoal(side, relay, seq, speed, clean) {
    if (this.phase !== "playing" || !relay?.alive || side !== relay.owner || seq !== relay.seq) return;
    const scorer = other(side);
    const points = this.arcade?.frenzy ? 2 : 1;
    this.score[scorer] += points;
    this.leavePlaying();
    for (const r of this.relays) r.kill();
    this.kickoff = side;
    const shot = Number.isFinite(speed) ? Math.max(0, speed) : 0;
    this.broadcast({
      type: "event",
      kind: "goal",
      side: scorer,
      speed: shot,
      screamer: !!clean && shot >= this.rules.screamerSpeed,
      points
    });
    this.phase = "goal";
    this.next = this.golden || this.score[scorer] >= this.rules.goalsToWin ? "end" : "kickoff";
    this.timerMs = this.rules.goalPauseMs;
    this.phaseTimer = setTimeout(() => this.runNext(), this.rules.goalPauseMs);
    this.broadcastMatch();
  }
  onTimeUp() {
    this.clockTimer = null;
    this.remainingMs = 0;
    this.clockSince = null;
    if (this.score.A !== this.score.B) {
      this.finishGame(this.score.A > this.score.B ? "A" : "B", false);
    } else {
      this.golden = true;
      this.tickArcade();
      this.broadcast({ type: "event", kind: "golden" });
      this.broadcastMatch();
    }
  }
  onStall() {
    this.stallTimer = null;
    if (this.phase !== "playing") return;
    const from = this.relay.owner;
    this.broadcast({ type: "event", kind: "stall", side: from });
    this.relay.take();
    this.relay.spawn(other(from));
  }
  finishGame(winner, forfeit) {
    this.leavePlaying();
    this.stopTimers();
    for (const r of this.relays) r.kill();
    this.seriesScore[winner]++;
    this.seriesDone = forfeit || !!this.bracket || this.config.series === 1 || this.seriesScore[winner] >= 2;
    this.phase = "full_time";
    const total = this.possession.A + this.possession.B;
    const stats = /* @__PURE__ */ __name((s) => ({
      goals: this.score[s],
      ...this.reported[s],
      possession: total > 0 ? Math.round(this.possession[s] / total * 100) : 50
    }), "stats");
    this.lastFullTime = {
      type: "full_time",
      winner,
      forfeit,
      score: { ...this.score },
      seriesScore: { ...this.seriesScore },
      seriesOver: this.seriesDone,
      stats: { A: stats("A"), B: stats("B") }
    };
    if (this.bracket && this.tieAt) {
      const tie2 = this.bracket[this.tieAt[0]][this.tieAt[1]];
      report(this.bracket, this.tieAt, winner === "A" ? tie2.a : tie2.b, [this.score.A, this.score.B]);
      this.tieAt = null;
      this.bracketTimer = setTimeout(() => this.nextTournamentTie(), this.rules.resultMs);
    }
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
  startTournament() {
    const entrants = this.players.map((p, id) => p && p.connected && !p.watch ? id : -1).filter((id) => id >= 0);
    if (entrants.length < 3) return;
    this.bracket = makeBracket(entrants, this.rng);
    this.bracketNames = {};
    for (const id of entrants) this.bracketNames[id] = this.players[id].name;
    this.team = 1;
    this.nextTournamentTie();
  }
  /** Seat the next two players, or stop at the champion. */
  nextTournamentTie() {
    this.bracketTimer = null;
    if (!this.bracket) return;
    for (const p of this.players) if (p) this.sit(p, null);
    let at = nextTie(this.bracket);
    while (at) {
      const tie2 = this.bracket[at[0]][at[1]];
      const gone = [tie2.a, tie2.b].filter((id) => !this.players[id]?.connected);
      if (!gone.length) break;
      for (const id of gone) withdraw(this.bracket, id);
      at = nextTie(this.bracket);
    }
    this.tieAt = at;
    this.phase = "lobby";
    this.score = { A: 0, B: 0 };
    this.seriesScore = { A: 0, B: 0 };
    this.lastFullTime = null;
    this.arcade = null;
    if (at) {
      const tie2 = this.bracket[at[0]][at[1]];
      this.sit(this.players[tie2.a], "A1");
      this.sit(this.players[tie2.b], "B1");
      this.nextTieAt = Date.now() + this.rules.nextTieMs;
      this.bracketTimer = setTimeout(() => {
        this.bracketTimer = null;
        if (this.phase === "lobby" && this.at("A1")?.connected && this.at("B1")?.connected) this.startGame();
      }, this.rules.nextTieMs);
    }
    this.broadcastRoom();
    this.broadcastMatch();
  }
  endTournament() {
    if (this.bracketTimer) clearTimeout(this.bracketTimer);
    this.bracketTimer = null;
    this.bracket = null;
    this.tieAt = null;
    this.reset();
    for (const p of this.players) if (p) this.sit(p, null);
    for (const p of this.players) {
      const seat = SEATS[this.team].find((s) => !this.at(s));
      if (p && !p.watch && seat) this.sit(p, seat);
    }
    this.broadcastRoom();
    this.broadcastMatch();
  }
  bracketState() {
    if (!this.bracket) return null;
    const waiting = this.bracketTimer && this.tieAt && this.phase === "lobby";
    return {
      rounds: this.bracket,
      current: this.tieAt,
      champion: champion(this.bracket),
      names: this.bracketNames,
      startInMs: waiting ? Math.max(0, this.nextTieAt - Date.now()) : null
    };
  }
  // --- pausing ---
  get live() {
    return this.phase === "countdown" || this.phase === "playing" || this.phase === "goal";
  }
  pause() {
    if (this.phase === "paused") this.broadcastMatch();
    if (!this.live) return;
    if (this.phase === "playing") this.next = "continue";
    this.leavePlaying();
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = null;
    this.phase = "paused";
    this.forfeitAt = Date.now() + this.rules.rejoinMs;
    this.forfeitTimer = setTimeout(() => this.onForfeit(), this.rules.rejoinMs);
    this.broadcastMatch();
  }
  maybeResume() {
    if (this.phase !== "paused" || !this.seated.every((p) => p.connected && !p.away)) return;
    if (this.forfeitTimer) clearTimeout(this.forfeitTimer);
    this.forfeitTimer = null;
    if (this.next === "end") this.runNext();
    else this.countdown(this.next);
  }
  onForfeit() {
    this.forfeitTimer = null;
    const here = ["A", "B"].filter((s) => this.seated.some((p) => p.side === s && p.connected && !p.away));
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
  startClock() {
    this.startPossession();
    this.armStall();
    if (this.arcade) {
      this.arcadeAt = Date.now();
      this.arcadeTimer = setInterval(() => this.tickArcade(), ARCADE_TICK_MS);
    }
    if (this.golden) return;
    this.clockSince = Date.now();
    this.clockTimer = setTimeout(() => this.onTimeUp(), this.remainingMs);
    if (this.remainingMs > 6e4) {
      this.minuteTimer = setTimeout(
        () => this.broadcast({ type: "event", kind: "last_minute" }),
        this.remainingMs - 6e4
      );
    }
  }
  /** Give the Arcade director the play time that has passed since it last looked. */
  tickArcade() {
    if (!this.arcade || this.phase !== "playing") return;
    const now = Date.now();
    const dt = now - this.arcadeAt;
    this.arcadeAt = now;
    if (dt > 0) this.arcade.advance(dt, this.golden);
  }
  /** Stop everything that only runs while the ball is in play. */
  leavePlaying() {
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
  armStall() {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => this.onStall(), this.rules.stallMs);
  }
  tallyPossession() {
    if (this.possSince === null) return;
    this.possession[this.possSide] += Date.now() - this.possSince;
    this.possSince = null;
  }
  /** Start timing the current owner's spell on the ball. */
  startPossession() {
    this.possSide = this.relay.owner;
    this.possSince = Date.now();
  }
  stopTimers() {
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
  drop(slot) {
    this.players[slot] = null;
    if (this.bracket) withdraw(this.bracket, slot);
    if (slot === this.host) {
      const next = this.players.findIndex(Boolean);
      if (next >= 0) this.host = next;
    }
  }
  /** Someone leaves while no match is being played. */
  remove(slot) {
    const wasSeated = !!this.players[slot]?.seat;
    this.drop(slot);
    if (wasSeated) {
      for (const p of this.seated) p.ready = false;
      if (this.bracket && this.phase === "lobby") {
        if (this.bracketTimer) clearTimeout(this.bracketTimer);
        this.nextTournamentTie();
        return;
      }
      if (this.phase === "full_time" && !this.bracket) this.reset();
    }
    this.broadcastRoom();
    this.broadcastMatch();
  }
  /** Back to an open lobby, ready for a new pairing. */
  reset() {
    this.phase = "lobby";
    this.score = { A: 0, B: 0 };
    this.seriesScore = { A: 0, B: 0 };
    this.game = 0;
    this.seriesDone = false;
    this.lastFullTime = null;
    this.arcade = null;
  }
  matchState() {
    const running = this.clockSince !== null ? Date.now() - this.clockSince : 0;
    return {
      type: "match_state",
      phase: this.phase,
      score: { ...this.score },
      remainingMs: Math.max(0, this.remainingMs - running),
      golden: this.golden,
      game: this.game,
      series: this.bracket ? 1 : this.config.series,
      seriesScore: { ...this.seriesScore },
      kickoff: this.kickoff,
      timerMs: this.phase === "paused" ? Math.max(0, this.forfeitAt - Date.now()) : this.timerMs,
      pauseReason: this.phase !== "paused" ? null : this.seated.some((p) => !p.connected) ? "disconnect" : "away",
      arcade: this.arcade?.state() ?? null
    };
  }
  broadcastMatch() {
    this.broadcast(this.matchState());
  }
  broadcastRoom() {
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
        watch: p.watch
      });
    }
    this.broadcast({
      type: "room_state",
      code: this.code,
      players,
      host: this.host,
      config: this.config,
      team: this.team,
      format: this.format,
      bracket: this.bracketState()
    });
  }
  broadcast(m) {
    for (let id = 0; id < this.players.length; id++) if (this.players[id]) this.sendSlot(id, m);
  }
  /** Ball messages go to whoever is running that half. */
  sendSide(side, m) {
    const runner = this.at(`${side}1`);
    if (runner) this.sendSlot(this.idOf(runner), m);
  }
};

// src/server/rooms.ts
var Rooms = class {
  constructor(opts = {}) {
    this.opts = opts;
  }
  opts;
  static {
    __name(this, "Rooms");
  }
  rooms = /* @__PURE__ */ new Map();
  get size() {
    return this.rooms.size;
  }
  /** Open a room. On Cloudflare the code is chosen before the room exists, so it can be passed in. */
  create(fixed) {
    let code = fixed ?? makeCode(this.opts.rng);
    while (!fixed && this.rooms.has(code)) code = makeCode();
    const entry = { room: null, sends: [], expiry: null };
    entry.room = new Room(code, (slot, m) => entry.sends[slot]?.(m), this.opts);
    this.rooms.set(code, entry);
    return entry;
  }
  get(code) {
    return this.rooms.get(code);
  }
  /** Call after anyone joins or leaves: an empty room is closed after a while. */
  touch(entry) {
    if (entry.expiry) clearTimeout(entry.expiry);
    entry.expiry = null;
    if (!entry.room.empty) return;
    entry.expiry = setTimeout(() => {
      if (!entry.room.empty) return;
      entry.room.close();
      this.rooms.delete(entry.room.code);
    }, this.opts.rules?.emptyRoomMs ?? RULES.emptyRoomMs);
  }
  close() {
    for (const e of this.rooms.values()) {
      if (e.expiry) clearTimeout(e.expiry);
      e.room.close();
    }
    this.rooms.clear();
  }
};

// src/worker/index.ts
var text = /* @__PURE__ */ __name((body, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain", "access-control-allow-origin": "*" } }), "text");
var RoomObject = class extends DurableObject {
  static {
    __name(this, "RoomObject");
  }
  rooms = new Rooms();
  code = "";
  async fetch(request) {
    const url = new URL(request.url);
    const code = url.searchParams.get("code") ?? "";
    if (url.pathname === "/claim") {
      if (this.code) return text("taken", 409);
      this.code = code;
      return text("ok");
    }
    if (request.headers.get("Upgrade") !== "websocket") return text("expected a WebSocket", 426);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const conn = connect(
      this.rooms,
      { send: /* @__PURE__ */ __name((d) => server.send(d), "send"), isOpen: /* @__PURE__ */ __name(() => server.readyState === WebSocket.OPEN, "isOpen") },
      { code: this.code || code }
    );
    server.addEventListener("message", (e) => conn.onMessage(typeof e.data === "string" ? e.data : ""));
    const gone = /* @__PURE__ */ __name(() => {
      conn.onClose();
      if (!this.rooms.size) this.code = "";
    }, "gone");
    server.addEventListener("close", gone);
    server.addEventListener("error", gone);
    return new Response(null, { status: 101, webSocket: client });
  }
};
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return text("ok");
    if (request.headers.get("Upgrade") !== "websocket") return text("split-screen football game server");
    const room = /* @__PURE__ */ __name((code2) => env.ROOMS.get(env.ROOMS.idFromName(code2)), "room");
    const forward = /* @__PURE__ */ __name((code2) => room(code2).fetch(new Request(`https://room/ws?code=${code2}`, request)), "forward");
    if (url.pathname === "/ws/new") {
      for (let tries = 0; tries < 8; tries++) {
        const code2 = makeCode();
        const claim = await room(code2).fetch(`https://room/claim?code=${code2}`);
        if (claim.ok) return forward(code2);
      }
      return text("no free room codes, try again", 503);
    }
    const match = /^\/ws\/room\/([A-Za-z]+)$/.exec(url.pathname);
    const code = match ? parseCode(match[1]) : null;
    if (code) return forward(code);
    return text("unknown address", 404);
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-RWLYDE/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-RWLYDE/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  RoomObject,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
