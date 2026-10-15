import { tuning, type Tuning } from '../shared/constants';
import type { Net } from './net';

const defaults: Tuning = { ...tuning };

/** [key, min, max, step] */
const SLIDERS: [keyof Tuning, number, number, number][] = [
  ['sensitivity', 0.3, 3, 0.05],
  ['maxShot', 15, 60, 1],
  ['gravity', 5, 30, 0.5],
  ['footRadius', 0.5, 2, 0.05],
  ['ballRadius', 0.3, 1.2, 0.05],
  ['groundBounce', 0.2, 0.9, 0.01],
  ['wallBounce', 0.2, 0.95, 0.01],
  ['rollFriction', 0, 8, 0.1],
  ['airDrag', 0, 0.5, 0.01],
  ['kickSoft', 0, 1, 0.01],
  ['kickHard', 0, 1, 0.01],
  ['smoothMs', 10, 150, 5],
];

/** Live tuning panel, toggled with the ` key. */
export class DebugPanel {
  open = false;
  private root: HTMLElement;
  private info: HTMLElement;
  private refreshers: (() => void)[] = [];

  constructor(root: HTMLElement) {
    this.root = root;
    const title = document.createElement('h2');
    title.textContent = 'Tuning';
    root.append(title);

    for (const [key, min, max, step] of SLIDERS) {
      this.slider(key, min, max, step, () => tuning[key], (v) => (tuning[key] = v));
    }

    const reset = document.createElement('button');
    reset.textContent = 'Reset to defaults';
    reset.onclick = () => {
      Object.assign(tuning, defaults);
      for (const fn of this.refreshers) fn();
    };
    root.append(reset);

    this.info = document.createElement('pre');
    root.append(this.info);
  }

  /** Adds the network test controls. They act on whichever connection is current. */
  attachNet(net: () => Net | null): void {
    const title = document.createElement('h2');
    title.textContent = 'Network test';
    this.root.insertBefore(title, this.info);
    const set = (fn: (n: Net) => void) => {
      const n = net();
      if (n) fn(n);
    };
    this.slider('added delay ms', 0, 400, 10, () => net()?.delayMs ?? 0, (v) => set((n) => (n.delayMs = v)), this.info);
    this.slider('ball msg loss %', 0, 50, 1, () => (net()?.loss ?? 0) * 100, (v) => set((n) => (n.loss = v / 100)), this.info);
  }

  toggle(): void {
    this.open = !this.open;
    this.root.hidden = !this.open;
  }

  setInfo(text: string): void {
    if (this.open) this.info.textContent = text;
  }

  private slider(
    label: string,
    min: number,
    max: number,
    step: number,
    get: () => number,
    set: (v: number) => void,
    before: HTMLElement | null = null,
  ): void {
    const row = document.createElement('label');
    const name = document.createElement('span');
    const input = document.createElement('input');
    const value = document.createElement('output');
    name.textContent = label;
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const refresh = () => {
      input.value = String(get());
      value.textContent = String(Math.round(get() * 100) / 100);
    };
    input.oninput = () => {
      set(Number(input.value));
      refresh();
    };
    refresh();
    this.refreshers.push(refresh);
    row.append(name, input, value);
    this.root.insertBefore(row, before);
  }
}
