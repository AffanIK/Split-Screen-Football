import type { Tuning } from './constants';

export type PowerKind =
  | 'giant'
  | 'shrink'
  | 'freeze'
  | 'fireball'
  | 'multiball'
  | 'biggoal'
  | 'ghost'
  | 'magnet'
  | 'nokeeper';
export type HazardKind = 'mine' | 'well' | 'mud';
/** Things that appear on the pitch: a power-up, a bonus target or a hazard. */
export type ItemKind = PowerKind | 'target' | HazardKind;
export type ModKind = 'lowgrav' | 'bigball' | 'tinyball' | 'wind' | 'icy' | 'turbo';
export type Mode = 'arcade' | 'classic';

/** Every Arcade number in one place, to be tuned after playtests. Times are ms of play. */
export const ARCADE = {
  goalGrowEveryMs: 30_000,
  goalGrowBy: 1.5,
  goalMaxH: 15.5,
  goalGoldenH: 18,

  /** A power-up is shown this long before it can be collected. */
  itemWarnMs: 3000,
  itemFirstMs: 5000,
  itemGapMinMs: 12_000,
  itemGapMaxMs: 18_000,
  itemLifeMs: 20_000,
  itemRadius: 1.3,

  targetFirstMs: 20_000,
  targetEveryMs: 25_000,
  targetLifeMs: 8000,

  modFirstWarnMs: 10_000,
  modEveryMs: 30_000,
  modWarnMs: 5000,
  modRunMs: 20_000,
  windAccel: 7,

  portalCycleMs: 35_000,
  portalOpenMs: 10_000,

  /** The frenzy covers this much of the end of normal time. */
  frenzyMs: 30_000,
  frenzyWarnMs: 5000,

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

  hazardFirstMs: 14_000,
  hazardEveryMs: 25_000,
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
  bigGoalMult: 1.5,
};

interface PowerInfo {
  name: string;
  /** What the player who got it is told. */
  text: string;
  /** How long it lasts; 0 for something that happens once. */
  ms: number;
  /** Whose boot or goal it acts on. */
  on: 'me' | 'them';
}

export const POWERS: Record<PowerKind, PowerInfo> = {
  giant: { name: 'GIANT BOOT', text: 'A HUGE BOOT FOR 8 SECONDS', ms: 8000, on: 'me' },
  shrink: { name: 'SHRINK', text: "THE OTHER BOOT IS TINY FOR 8 SECONDS", ms: 8000, on: 'them' },
  freeze: { name: 'FREEZE', text: 'THE OTHER BOOT IS FROZEN FOR 2 SECONDS', ms: 2000, on: 'them' },
  fireball: { name: 'FIREBALL', text: 'SUPER METER FULL: SHOOT HARD', ms: 0, on: 'me' },
  multiball: { name: 'MULTIBALL', text: 'A SECOND BALL DROPS IN', ms: 0, on: 'me' },
  biggoal: { name: 'BIG GOAL', text: "THE OTHER GOAL IS TALLER FOR 10 SECONDS", ms: 10_000, on: 'them' },
  ghost: { name: 'GHOST BALL', text: 'THE NEXT SHOT CANNOT BE SEEN COMING', ms: 0, on: 'me' },
  magnet: { name: 'MAGNET', text: 'THE BALL IS DRAWN TO THE BOOT FOR 8 SECONDS', ms: 8000, on: 'me' },
  nokeeper: { name: 'KEEPER OFF', text: 'THE OTHER KEEPER LEAVES FOR 6 SECONDS', ms: 6000, on: 'them' },
};

export const POWER_KINDS = Object.keys(POWERS) as PowerKind[];

export const HAZARDS: Record<HazardKind, { name: string; text: string; lifeMs: number }> = {
  mine: { name: 'MINE', text: 'IT THROWS THE BALL ANYWHERE', lifeMs: 12_000 },
  well: { name: 'GRAVITY WELL', text: 'IT DRAGS THE BALL IN', lifeMs: 8000 },
  mud: { name: 'MUD', text: 'THE BALL STOPS DEAD', lifeMs: 10_000 },
};

export const HAZARD_KINDS = Object.keys(HAZARDS) as HazardKind[];

export const isHazard = (k: ItemKind): k is HazardKind => k in HAZARDS;
export const isPower = (k: ItemKind): k is PowerKind => k in POWERS;

/** What to call any item in a banner or marker. */
export function itemName(k: ItemKind): string {
  return isPower(k) ? POWERS[k].name : isHazard(k) ? HAZARDS[k].name : 'TARGET';
}

export const MODS: Record<ModKind, { name: string; text: string }> = {
  lowgrav: { name: 'LOW GRAVITY', text: 'THE BALL FLOATS' },
  bigball: { name: 'BIG BALL', text: 'HARD TO MISS, HARD TO STOP' },
  tinyball: { name: 'TINY BALL', text: 'SMALL AND SLIPPERY' },
  wind: { name: 'CROSSWIND', text: 'IT TURNS HALFWAY THROUGH' },
  icy: { name: 'ICY PITCH', text: 'THE BALL SLIDES FOREVER' },
  turbo: { name: 'TURBO', text: 'EVERYTHING FLIES FASTER' },
};

export const MOD_KINDS = Object.keys(MODS) as ModKind[];

/** How far above the normal cap a ball may legitimately travel. */
export function speedLimitScale(mod: ModKind | null, fire: boolean): number {
  return (mod === 'turbo' ? 1.3 : 1) * (fire ? ARCADE.fireMult : 1);
}

/** Sideways push on the ball, m/s², in world direction. It reverses halfway through the modifier. */
export function windNow(mod: ModKind | null, leftMs: number): number {
  if (mod !== 'wind') return 0;
  return leftMs > ARCADE.modRunMs / 2 ? ARCADE.windAccel : -ARCADE.windAccel;
}

/**
 * The tuning a screen should simulate with right now: the base values, bent by
 * the running modifier and by the power-ups acting on this player's boot.
 */
export function effectiveTuning(base: Tuning, mod: ModKind | null, onMe: readonly PowerKind[]): Tuning {
  const t = { ...base };
  switch (mod) {
    case 'lowgrav':
      t.gravity *= 0.45;
      break;
    case 'bigball':
      t.ballRadius *= 1.6;
      break;
    case 'tinyball':
      t.ballRadius *= 0.65;
      break;
    case 'icy':
      t.rollFriction *= 0.08;
      t.groundBounce = Math.min(0.8, t.groundBounce + 0.12);
      break;
    case 'turbo':
      t.maxShot *= 1.3;
      t.kickSoft += 0.15;
      t.kickHard += 0.2;
      break;
  }
  if (onMe.includes('giant')) t.footRadius *= 1.6;
  if (onMe.includes('shrink')) t.footRadius *= 0.6;
  return t;
}
