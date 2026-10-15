import { POWERS, isPower, type ItemKind, type PowerKind } from '../shared/effects';
import type { FullTimeMsg } from '../shared/protocol';
import type { Side } from '../shared/types';

const KEY = 'ssf-records';

/** One player's history on this device. There are no accounts, so it lives in the browser. */
export interface Records {
  played: number;
  wins: number;
  losses: number;
  streak: number;
  bestStreak: number;
  goals: number;
  /** m/s */
  fastest: number;
  juggle: number;
  saves: number;
  /** How many of each power-up have been collected. */
  powers: Partial<Record<PowerKind, number>>;
  tournaments: number;
}

const empty: Records = {
  played: 0,
  wins: 0,
  losses: 0,
  streak: 0,
  bestStreak: 0,
  goals: 0,
  fastest: 0,
  juggle: 0,
  saves: 0,
  powers: {},
  tournaments: 0,
};

export function loadRecords(): Records {
  try {
    return { ...empty, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...empty, powers: {} };
  }
}

function save(r: Records): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    /* storage unavailable */
  }
}

/** Add a finished game. Returns a line for each personal best it set. */
export function recordGame(r: Records, result: FullTimeMsg, side: Side): string[] {
  const mine = result.stats[side];
  const news: string[] = [];
  r.played++;
  r.goals += mine.goals;
  r.saves += mine.saves;
  if (result.winner === side) {
    r.wins++;
    r.streak++;
    if (r.streak > r.bestStreak) {
      r.bestStreak = r.streak;
      if (r.streak >= 2) news.push(`BEST WIN STREAK: ${r.streak}`);
    }
  } else {
    r.losses++;
    r.streak = 0;
  }
  if (mine.fastest > r.fastest) {
    r.fastest = mine.fastest;
    news.push(`FASTEST SHOT: ${Math.round(mine.fastest * 3.6)} KM/H`);
  }
  if (mine.juggle > r.juggle) {
    r.juggle = mine.juggle;
    if (mine.juggle >= 3) news.push(`BEST JUGGLE: ${mine.juggle}`);
  }
  save(r);
  return news;
}

export function recordPickup(r: Records, item: ItemKind): void {
  if (!isPower(item)) return;
  r.powers[item] = (r.powers[item] ?? 0) + 1;
  save(r);
}

export function recordTournament(r: Records): void {
  r.tournaments++;
  save(r);
}

/** Rows for the records screen. */
export function recordRows(r: Records): [string, string][] {
  const fav = (Object.entries(r.powers) as [PowerKind, number][]).sort((a, b) => b[1] - a[1])[0];
  return [
    ['MATCHES', String(r.played)],
    ['WON / LOST', `${r.wins} / ${r.losses}`],
    ['WIN STREAK', `${r.streak}  (BEST ${r.bestStreak})`],
    ['GOALS', String(r.goals)],
    ['SAVES', String(r.saves)],
    ['FASTEST SHOT', `${Math.round(r.fastest * 3.6)} KM/H`],
    ['BEST JUGGLE', String(r.juggle)],
    ['FAVOURITE POWER-UP', fav ? `${POWERS[fav[0]].name} (${fav[1]})` : '-'],
    ['TOURNAMENTS WON', String(r.tournaments)],
  ];
}
