import type { ItemKind, PowerKind } from '../../shared/effects';
import type { Side } from '../../shared/types';
import { fromRows, paint } from './pixel';

export const TEAM: Record<Side, { main: string; light: string; dark: string; name: string }> = {
  A: { main: '#3b82f6', light: '#8ab6ff', dark: '#1d4fb8', name: 'BLUE' },
  B: { main: '#f6872f', light: '#ffc08a', dark: '#b85a12', name: 'ORANGE' },
};

// --- ball ---

export const BALL_SIZE = 15;
const BALL_FRAMES = 8;
/** The panel pattern repeats every fifth of a turn. */
const BALL_PERIOD = (Math.PI * 2) / 5;

function ballFrame(angle: number): HTMLCanvasElement {
  const c = (BALL_SIZE - 1) / 2;
  return paint(BALL_SIZE, BALL_SIZE, (x, y) => {
    const dx = x - c;
    const dy = y - c;
    const d = Math.hypot(dx, dy);
    if (d > 7.4) return null;
    // A mid-tone rim, so the outline still shows against the night sky.
    if (d > 6.3) return '#59638f';
    // Rotate into the ball's own frame to find the dark panels.
    const u = dx * Math.cos(angle) + dy * Math.sin(angle);
    const v = -dx * Math.sin(angle) + dy * Math.cos(angle);
    // A small centre panel and five around it, kept clear of the rim so the
    // ball stays a clean white disc.
    let dark = Math.hypot(u, v) < 1.5;
    for (let i = 0; i < 5 && !dark; i++) {
      const a = i * BALL_PERIOD;
      dark = Math.hypot(u - Math.cos(a) * 4.3, v - Math.sin(a) * 4.3) < 1.25;
    }
    if (dark) return '#2a3154';
    // Lit from the upper left by the floodlights.
    if (dx + dy > 6) return '#c3cae6';
    return '#ffffff';
  });
}

let ballFrames: HTMLCanvasElement[] | null = null;

export function ballSprite(angle: number): HTMLCanvasElement {
  ballFrames ??= Array.from({ length: BALL_FRAMES }, (_, i) => ballFrame((i / BALL_FRAMES) * BALL_PERIOD));
  // Canvas y points down, so a world rotation is drawn the other way round.
  const turn = (((-angle % BALL_PERIOD) + BALL_PERIOD) % BALL_PERIOD) / BALL_PERIOD;
  return ballFrames[Math.floor(turn * BALL_FRAMES) % BALL_FRAMES];
}

// --- boot ---

export const BOOT_SIZE = 28;
const TILTS = [-0.5, -0.25, 0, 0.25, 0.5];

// Faces right. K outline, C team colour, L highlight, W white, S sole, T studs.
const BOOT = [
  '....KKKKKK......',
  '....KCCCCK......',
  '....KWWWWK......',
  '....KCCCCK......',
  '....KCCCCK......',
  '....KCCCCKK.....',
  '....KCCLCCCKK...',
  '....KCCCLCCCCKK.',
  '...KCCCCCLLCCCCK',
  '...KCCCCCCCCCCCK',
  '...KWWWWWWWWWWWK',
  '...KSSSSSSSSSSSK',
  '....T..T...T.T..',
];

function bootFrame(side: Side, tilt: number): HTMLCanvasElement {
  const team = TEAM[side];
  const palette: Record<string, string> = {
    K: '#0b0e1c',
    C: team.main,
    L: team.light,
    W: '#f4f6ff',
    S: '#2a2f4a',
    T: '#c9cfe6',
  };
  const c = (BOOT_SIZE - 1) / 2;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const flip = side === 'B' ? -1 : 1;
  return paint(BOOT_SIZE, BOOT_SIZE, (x, y) => {
    const dx = (x - c) * flip;
    const dy = y - c;
    // Sample the upright boot at the un-rotated position. Positive tilt lifts the toe.
    const sx = Math.round(dx * cos - dy * sin + 8.5);
    const sy = Math.round(dx * sin + dy * cos + 6);
    const ch = BOOT[sy]?.[sx];
    if (ch && ch !== '.') return palette[ch];
    // The ring is exactly what touches the ball.
    const d = Math.hypot(x - c, y - c);
    if (d > 13.4) return null;
    if (d > 12.4) return team.light;
    if (d > 11.4) return team.main;
    // A dark disc behind the boot keeps it readable against the crowd.
    return (x + y) % 2 === 0 ? `${team.dark}cc` : '#0b0e1caa';
  });
}

const boots: Partial<Record<Side, HTMLCanvasElement[]>> = {};

/** `lean` is the tilt in radians; positive lifts the toe. */
export function bootSprite(side: Side, lean: number): HTMLCanvasElement {
  const frames = (boots[side] ??= TILTS.map((t) => bootFrame(side, t)));
  const i = Math.round(Math.max(-0.5, Math.min(0.5, lean)) / 0.25) + 2;
  return frames[i];
}

// --- crowd ---

export const FAN_W = 6;
export const FAN_H = 7;

const FAN_IDLE = ['..HH..', '..HH..', '.SSSS.', 'SSSSSS', 'HSSSSH', '.SSSS.', '.DDDD.'];
const FAN_UP = ['H.HH.H', 'S.HH.S', 'SSSSSS', '.SSSS.', '.SSSS.', '.SSSS.', '.DDDD.'];

const SKIN = ['#f1c9a5', '#c98f62', '#7a4f31'];
/** Shirts: two blues, two oranges, then neutral colours. */
export const SHIRTS = ['#2f6fe0', '#5b95f7', '#e87722', '#f8a04e', '#c9cfe6', '#7c86a8', '#3a4368'];

const fans = new Map<number, HTMLCanvasElement>();

export function fanSprite(shirt: number, skin: number, up: boolean): HTMLCanvasElement {
  const key = shirt * 100 + skin * 10 + (up ? 1 : 0);
  let s = fans.get(key);
  if (!s) {
    s = fromRows(up ? FAN_UP : FAN_IDLE, { H: SKIN[skin], S: SHIRTS[shirt], D: '#141936' });
    fans.set(key, s);
  }
  return s;
}

// --- arcade: power-ups, targets, bumpers, portals ---

export const ITEM_SIZE = 19;

const GLYPHS: Record<PowerKind, string[]> = {
  giant: ['....X....', '...XXX...', '..XXXXX..', '.XXXXXXX.', '...XXX...', '...XXX...', '...XXX...', '...XXX...', '.........'],
  shrink: ['.........', '...XXX...', '...XXX...', '...XXX...', '...XXX...', '.XXXXXXX.', '..XXXXX..', '...XXX...', '....X....'],
  freeze: ['....X....', '.X..X..X.', '..X.X.X..', '...XXX...', 'XXXXXXXXX', '...XXX...', '..X.X.X..', '.X..X..X.', '....X....'],
  fireball: ['....X....', '...XX....', '...XXX...', '..XXXX.X.', '.XXXXXXX.', '.XXXXXXX.', '.XXX.XXX.', '..XX.XX..', '...XXX...'],
  multiball: ['.........', '.XXX.....', 'XXXXX....', 'XXXXX....', '.XXX.XXX.', '....XXXXX', '....XXXXX', '.....XXX.', '.........'],
  biggoal: ['XXXXXXXXX', 'X.......X', 'X...X...X', 'X..XXX..X', 'X.X.X.X.X', 'X...X...X', 'X...X...X', 'X.......X', 'X.......X'],
  ghost: ['..XXXXX..', '.XXXXXXX.', 'XX.XXX.XX', 'XX.XXX.XX', 'XXXXXXXXX', 'XXXXXXXXX', 'XXXXXXXXX', 'XX.XXX.XX', 'X...X...X'],
  magnet: ['XXX...XXX', 'XXX...XXX', '.........', 'XXX...XXX', 'XXX...XXX', 'XXX...XXX', 'XXXX.XXXX', '.XXXXXXX.', '..XXXXX..'],
  nokeeper: ['X.......X', '.X.....X.', '..X...X..', '...X.X...', '....X....', '...X.X...', '..X...X..', '.X.....X.', 'X.......X'],
};

export const ITEM_COLOUR: Record<PowerKind, string> = {
  giant: '#1f9d55',
  shrink: '#8b46d6',
  freeze: '#1f93c4',
  fireball: '#e8501e',
  multiball: '#4a5488',
  biggoal: '#b8860b',
  ghost: '#55607f',
  magnet: '#c8324a',
  nokeeper: '#0f766e',
};

const itemSprites = new Map<ItemKind, HTMLCanvasElement>();

/** A round badge with the power-up's symbol, or a ringed target. */
export function itemSprite(kind: ItemKind): HTMLCanvasElement {
  let s = itemSprites.get(kind);
  if (s) return s;
  const c = (ITEM_SIZE - 1) / 2;
  s = paint(ITEM_SIZE, ITEM_SIZE, (x, y) => {
    const d = Math.hypot(x - c, y - c);
    if (d > 9.4) return null;
    if (kind === 'target') return d > 7.4 ? '#f4f6ff' : d > 5 ? '#e23b3b' : d > 2.6 ? '#f4f6ff' : '#e23b3b';
    if (kind === 'mine') {
      // A dark ball with spikes and a red light.
      if (d < 2) return '#ff3b3b';
      if (d < 6.2) return x + y < 16 ? '#59638f' : '#2a2f4a';
      const a = Math.atan2(y - c, x - c);
      return Math.abs(Math.sin(a * 4)) < 0.35 ? '#c9cfe6' : null;
    }
    if (kind === 'well') return d > 8.2 ? '#c77dff' : d > 5.5 ? '#3c096c' : d > 3 ? '#7b2cbf' : '#05070f';
    if (kind === 'mud') return Math.abs(y - c) > 5 ? null : (x * 7 + y * 3) % 5 === 0 ? '#8a5a2b' : '#5c3a1a';
    if (d > 8.2) return '#f4f6ff';
    return GLYPHS[kind][y - 5]?.[x - 5] === 'X' ? '#ffffff' : ITEM_COLOUR[kind];
  });
  itemSprites.set(kind, s);
  return s;
}

const itemUrls = new Map<ItemKind, string>();

/** The same badge as an image URL, for the DOM interface. */
export function itemUrl(kind: ItemKind): string {
  let u = itemUrls.get(kind);
  if (!u) {
    u = itemSprite(kind).toDataURL();
    itemUrls.set(kind, u);
  }
  return u;
}

const bumpers = new Map<string, HTMLCanvasElement>();

/** A pinball bumper of the given radius in pixels; `lit` just after it is hit. */
export function bumperSprite(radius: number, lit: boolean): HTMLCanvasElement {
  const key = `${radius}${lit}`;
  let s = bumpers.get(key);
  if (!s) {
    const size = radius * 2 + 1;
    s = paint(size, size, (x, y) => {
      const d = Math.hypot(x - radius, y - radius);
      if (d > radius + 0.4) return null;
      if (d > radius - 1.6) return lit ? '#ffffff' : '#ffd23f';
      if (d > radius - 4) return lit ? '#ffd23f' : '#c8324a';
      if (d > radius * 0.42) return lit ? '#ff8a5c' : '#8a1f33';
      return lit ? '#ffffff' : '#ffd23f';
    });
    bumpers.set(key, s);
  }
  return s;
}

const portals = new Map<string, HTMLCanvasElement>();

/** A portal ring. Open rings swirl through four frames; closed ones are a dull outline. */
export function portalSprite(radius: number, open: boolean, frame: number): HTMLCanvasElement {
  const key = `${radius}${open}${frame}`;
  let s = portals.get(key);
  if (!s) {
    const size = radius * 2 + 1;
    s = paint(size, size, (x, y) => {
      const dx = x - radius;
      const dy = y - radius;
      const d = Math.hypot(dx, dy);
      if (d > radius + 0.4) return null;
      if (!open) return d > radius - 2 ? '#59638f' : (x + y) % 4 === 0 ? '#2b3364' : null;
      if (d > radius - 2) return '#e6c9ff';
      // Spiral arms that turn with the frame.
      const arm = Math.floor((Math.atan2(dy, dx) / (Math.PI * 2)) * 8 + d * 0.35 + frame * 2 + 16) % 4;
      return arm === 0 ? '#c77dff' : arm === 1 ? '#7b2cbf' : '#3c096c';
    });
    portals.set(key, s);
  }
  return s;
}

// --- goalkeeper bot ---

const KEEPER = [
  '.....HHH.....',
  '.....HHH.....',
  'G...SSSSS...G',
  'GG.SSSSSSS.GG',
  '.GSSSSSSSSSG.',
  '..SSSSSSSSS..',
  '...SSSSSSS...',
  '...SSSSSSS...',
  '...SSSSSSS...',
  '...PPPPPPP...',
  '...PP...PP...',
  '...PP...PP...',
  '...PP...PP...',
  '...KK...KK...',
];

let keeper: HTMLCanvasElement | null = null;

/** The keeper, arms out. Drawn at twice this size. */
export function keeperSprite(): HTMLCanvasElement {
  keeper ??= fromRows(KEEPER, { H: '#f1c9a5', S: '#ffd23f', G: '#f4f6ff', P: '#1b2038', K: '#0b0e1c' });
  return keeper;
}

// --- goal net ---

export function netSprite(w: number, h: number): HTMLCanvasElement {
  return paint(w, h, (x, y) => ((x + y) % 6 === 0 || (x - y + 600) % 6 === 0 ? 'rgba(226,232,255,0.55)' : null));
}
