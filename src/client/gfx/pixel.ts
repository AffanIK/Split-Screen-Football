// The whole game is drawn into a small buffer and scaled up with hard edges,
// so every sprite, line and particle is made of the same size of pixel.

export const BUF_W = 640;
export const BUF_H = 360;
/** Buffer pixels per metre: the 50 m half fills the 640 px width. */
export const PPM = BUF_W / 50;
/** Buffer row of the ground line (world y = 0). */
export const GROUND_PY = 320;

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Build a sprite one pixel at a time. `fn` returns a CSS colour, or null for transparent. */
export function paint(w: number, h: number, fn: (x: number, y: number) => string | null): HTMLCanvasElement {
  const c = makeCanvas(w, h);
  const ctx = ctx2d(c);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const colour = fn(x, y);
      if (colour) {
        ctx.fillStyle = colour;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
  return c;
}

/** Sprite from rows of characters, each looked up in a palette. '.' is transparent. */
export function fromRows(rows: string[], palette: Record<string, string>): HTMLCanvasElement {
  return paint(rows[0].length, rows.length, (x, y) => palette[rows[y][x]] ?? null);
}

const TEXT_FONT = '8px "Press Start 2P", monospace';
const texts = new Map<string, HTMLCanvasElement>();

/**
 * A line of 8-pixel-high text as a sprite, with its soft edges snapped to
 * hard pixels. Cached, so it is cheap to ask for the same text every frame.
 */
export function pixelText(text: string, colour: string): HTMLCanvasElement {
  const key = `${colour}|${text}`;
  let c = texts.get(key);
  if (c) return c;
  const probe = ctx2d(makeCanvas(1, 1));
  probe.font = TEXT_FONT;
  const w = Math.max(1, Math.ceil(probe.measureText(text).width));
  c = makeCanvas(w, 8);
  const ctx = ctx2d(c);
  ctx.font = TEXT_FONT;
  ctx.textBaseline = 'top';
  ctx.fillStyle = colour;
  ctx.fillText(text, 0, 0);
  const img = ctx.getImageData(0, 0, w, 8);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] > 110 ? 255 : 0;
  ctx.putImageData(img, 0, 0);
  // Countdowns make many short-lived strings; do not keep them all.
  if (texts.size > 400) texts.clear();
  texts.set(key, c);
  return c;
}

/** Repeatable pseudo-random number in 0..1 from an integer. */
export function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** World metres to buffer pixels. */
export const px = (x: number, x0: number): number => Math.round((x - x0) * PPM);
export const py = (y: number): number => Math.round(GROUND_PY - y * PPM);
