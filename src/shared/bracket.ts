/** One tie in a knockout. Players are named by their room id; null is an empty place. */
export interface Tie {
  a: number | null;
  b: number | null;
  winner: number | null;
  /** Goals for a and b, once played. */
  score: [number, number] | null;
  /** Nothing more can happen here: it was played, or was a bye, or nobody reached it. */
  done: boolean;
}

/** Rounds of a single-elimination bracket, first round first; the last round is the final. */
export type Bracket = Tie[][];

/** Who meets whom in the first round, so that byes go to different ties rather than meeting each other. */
const ORDER: Record<number, number[]> = {
  2: [0, 1],
  4: [0, 3, 1, 2],
  8: [0, 7, 3, 4, 1, 6, 2, 5],
};

const tie = (): Tie => ({ a: null, b: null, winner: null, score: null, done: false });

/** Draw a bracket for 2 to 8 players, in random order, with byes filling the gaps. */
export function makeBracket(ids: readonly number[], rng: () => number = Math.random): Bracket {
  const drawn = [...ids];
  for (let i = drawn.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [drawn[i], drawn[j]] = [drawn[j], drawn[i]];
  }
  const size = drawn.length <= 2 ? 2 : drawn.length <= 4 ? 4 : 8;
  const order = ORDER[size];
  const rounds: Bracket = [];
  for (let n = size / 2; n >= 1; n /= 2) rounds.push(Array.from({ length: n }, tie));
  rounds[0].forEach((t, i) => {
    t.a = drawn[order[i * 2]] ?? null;
    t.b = drawn[order[i * 2 + 1]] ?? null;
  });
  settle(rounds);
  return rounds;
}

/** Carry winners forward, and award any tie that has only one player to play it. */
export function settle(rounds: Bracket): void {
  rounds.forEach((round, r) => {
    round.forEach((t, i) => {
      if (t.done) return;
      if (r > 0) {
        const fa = rounds[r - 1][i * 2];
        const fb = rounds[r - 1][i * 2 + 1];
        t.a = fa.winner;
        t.b = fb.winner;
        // Still waiting for one of the ties that feed this one.
        if (!fa.done || !fb.done) return;
      }
      if (t.a === null || t.b === null) {
        t.winner = t.a ?? t.b;
        t.done = true;
      }
    });
  });
}

/** The next tie that can be played, as [round, index]. */
export function nextTie(rounds: Bracket): [number, number] | null {
  for (let r = 0; r < rounds.length; r++) {
    const i = rounds[r].findIndex((t) => !t.done && t.a !== null && t.b !== null);
    if (i >= 0) return [r, i];
  }
  return null;
}

export function report(rounds: Bracket, at: [number, number], winner: number, score: [number, number]): void {
  const t = rounds[at[0]][at[1]];
  t.winner = winner;
  t.score = score;
  t.done = true;
  settle(rounds);
}

/** A player has left: any tie they had still to play goes to the other player. */
export function withdraw(rounds: Bracket, id: number): void {
  for (const round of rounds) {
    for (const t of round) {
      if (t.done) continue;
      if (t.a === id) t.a = null;
      if (t.b === id) t.b = null;
    }
  }
  // A winner who leaves cannot play the next round either.
  for (const round of rounds) for (const t of round) if (t.done && t.winner === id && t !== rounds.at(-1)![0]) t.winner = null;
  settle(rounds);
}

/** The winner of the final, once it is decided. */
export function champion(rounds: Bracket): number | null {
  const final = rounds.at(-1)![0];
  return final.done ? final.winner : null;
}
