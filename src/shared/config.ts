import { ARENAS, type ArenaKind } from './arena';

export type KeeperLevel = 'off' | 'easy' | 'normal' | 'hard';
export type ArenaChoice = ArenaKind | 'random';

/** The rules of a match, set by the room's creator in the lobby. */
export interface Config {
  /** Changing any rule by hand turns the preset into `custom`. */
  preset: 'arcade' | 'classic' | 'custom';
  minutes: number;
  goals: number;
  series: 1 | 3;
  arena: ArenaChoice;
  keeper: KeeperLevel;
  powerups: boolean;
  modifiers: boolean;
  hazards: boolean;
  growing: boolean;
  frenzy: boolean;
}

export const MINUTES = [1, 2, 3, 5];
export const GOALS = [3, 5, 7, 10];
export const KEEPER_LEVELS: KeeperLevel[] = ['off', 'easy', 'normal', 'hard'];
export const ARENA_CHOICES = ['random', ...(Object.keys(ARENAS) as ArenaKind[])] as ArenaChoice[];
export const SWITCHES = ['powerups', 'modifiers', 'hazards', 'growing', 'frenzy'] as const;

export const PRESETS: Record<'arcade' | 'classic', Config> = {
  arcade: {
    preset: 'arcade',
    minutes: 3,
    goals: 5,
    series: 1,
    arena: 'random',
    keeper: 'normal',
    powerups: true,
    modifiers: true,
    hazards: true,
    growing: true,
    frenzy: true,
  },
  classic: {
    preset: 'classic',
    minutes: 3,
    goals: 5,
    series: 1,
    arena: 'none',
    keeper: 'off',
    powerups: false,
    modifiers: false,
    hazards: false,
    growing: false,
    frenzy: false,
  },
};

/** Does this match need any of the Arcade machinery at all? */
export function usesArcade(c: Config): boolean {
  return c.arena !== 'none' || c.keeper !== 'off' || SWITCHES.some((k) => c[k]);
}

/**
 * Apply a change asked for by the creator, ignoring anything that is not a
 * valid choice. Picking a preset replaces every rule except the series length.
 */
export function patchConfig(c: Config, patch: Partial<Config>): Config {
  if (patch.preset === 'arcade' || patch.preset === 'classic') return { ...PRESETS[patch.preset], series: c.series };
  const next = { ...c };
  if (MINUTES.includes(patch.minutes as number)) next.minutes = patch.minutes!;
  if (GOALS.includes(patch.goals as number)) next.goals = patch.goals!;
  if (patch.series === 1 || patch.series === 3) next.series = patch.series;
  if (ARENA_CHOICES.includes(patch.arena as ArenaChoice)) next.arena = patch.arena!;
  if (KEEPER_LEVELS.includes(patch.keeper as KeeperLevel)) next.keeper = patch.keeper!;
  for (const k of SWITCHES) if (typeof patch[k] === 'boolean') next[k] = patch[k]!;

  // The series length is not part of a preset; any other change makes the rules custom.
  const same = (Object.keys(next) as (keyof Config)[]).every((k) => k === 'series' || next[k] === c[k]);
  if (!same) next.preset = 'custom';
  return next;
}

/** One line for the lobby. */
export function describeConfig(c: Config): string {
  const arena = c.arena === 'random' ? 'RANDOM ARENA' : ARENAS[c.arena].name;
  const parts = [c.preset.toUpperCase(), `${c.minutes} MIN`, `FIRST TO ${c.goals}`, arena];
  if (c.keeper !== 'off') parts.push(`KEEPER ${c.keeper.toUpperCase()}`);
  if (c.series === 3) parts.push('BEST OF 3');
  return parts.join(' / ');
}

const NAME_MAX = 10;

/** Tidy a player's name: capitals, digits and spaces only, at most ten characters. */
export function cleanName(raw: unknown): string {
  const name = String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return name || 'PLAYER';
}

export const EMOTES = ['NICE!', 'WOW!', 'OOPS', 'GG', 'HAHA', 'LUCKY!'];
/** A player can send one emote in this long. */
export const EMOTE_GAP_MS = 2000;
