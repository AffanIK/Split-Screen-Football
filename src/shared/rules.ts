/** Match rules. The server enforces them; tests and the soak run override some. */
export const RULES = {
  goalsToWin: 5,
  matchMs: 180_000,
  goalPauseMs: 2000,
  countdownMs: 3000,
  /** One player keeping the ball this long gets it taken away. */
  stallMs: 8000,
  /** Time a missing player has to come back before forfeiting. */
  rejoinMs: 30_000,
  emptyRoomMs: 600_000,
  /** Tournament: how long a result is shown, and how long the next two players have to get ready. */
  resultMs: 6000,
  nextTieMs: 20_000,
  /** A goal from an untouched shot at least this fast is a screamer. */
  screamerSpeed: 29,
};

export type Rules = typeof RULES;

/** No I or O, so a code read aloud cannot be confused with 1 or 0. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 4;

export function makeCode(rng: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  return code;
}

/** Tidy what a player typed; null if it cannot be a room code. */
export function parseCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}
