const KEY = 'ssf-settings';

export interface Settings {
  sensitivity: number;
  /** 0..1 */
  sfx: number;
  music: number;
  muted: boolean;
  shake: boolean;
  flashes: boolean;
  /** Keep the pointer inside the game window during play. */
  lock: boolean;
  /** Shown to the other player. Empty until the player has been asked. */
  name: string;
  /** Show and send emotes. */
  emotes: boolean;
}

const defaults: Settings = {
  sensitivity: 1,
  sfx: 0.8,
  music: 0.5,
  muted: false,
  shake: true,
  flashes: true,
  lock: true,
  name: '',
  emotes: true,
};

export function loadSettings(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
