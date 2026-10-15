import { ARENAS } from '../../shared/arena';
import {
  ARENA_CHOICES,
  EMOTES,
  GOALS,
  KEEPER_LEVELS,
  MINUTES,
  cleanName,
  describeConfig,
  type Config,
} from '../../shared/config';
import { POWERS, POWER_KINDS, type ItemKind, type PowerKind } from '../../shared/effects';
import type {
  BracketState,
  Format,
  FullTimeMsg,
  PlayerStats,
  RoomStateMsg,
  Seat,
  Series,
  Slot,
  TeamSize,
} from '../../shared/protocol';
import { itemUrl } from '../gfx/sprites';
import { parseCode } from '../../shared/rules';
import type { Side } from '../../shared/types';
import type { Settings } from '../settings';

export type ScreenName =
  | 'splash'
  | 'menu'
  | 'join'
  | 'lobby'
  | 'howto'
  | 'arcade'
  | 'bracket'
  | 'name'
  | 'records'
  | 'rules'
  | 'settings'
  | 'pause'
  | 'fulltime';

/** A power-up shown under a player's score. */
export interface Chip {
  kind: PowerKind;
  /** Seconds left, or null for something waiting to be used. */
  secs: number | null;
  /** 0..1 of its time remaining. */
  share: number;
  /** It is acting against this player. */
  bad: boolean;
}

export interface ArcadeHud {
  meterA: number;
  meterB: number;
  mod: { label: string; share: number; state: 'idle' | 'soon' | 'now' };
  grow: string;
  chipsA: Chip[];
  chipsB: Chip[];
}

export interface Handlers {
  start(): void;
  create(): void;
  join(code: string): void;
  practice(): void;
  ready(): void;
  swap(): void;
  /** The creator changes a match rule. */
  config(patch: Partial<Config>): void;
  emote(id: number): void;
  /** Take a seat, or null to watch. */
  seat(seat: Seat | null): void;
  team(size: TeamSize): void;
  format(f: Format): void;
  startTournament(): void;
  endTournament(): void;
  copyWatch(): void;
  /** The player has typed their name. */
  named(name: string): void;
  /** Rows for the records screen. */
  records(): [string, string][];
  leave(): void;
  resume(): void;
  copy(): void;
  mute(): void;
  settingsChanged(): void;
  /** Interface sounds: a move or a confirm. */
  sound(confirm: boolean): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const kmh = (ms: number) => Math.round(ms * 3.6);

/** Hide the browser's own bars so the game has the whole display. */
export function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => {});
}

/** The menus, lobby, scoreboard and callouts: a DOM layer over the game canvas. */
export class UI {
  screen: ScreenName | null = null;
  private screens = new Map<string, HTMLElement>();
  /** Screens to return to with BACK. */
  private stack: ScreenName[] = [];
  private calloutTimer = 0;
  private bannerTimer = 0;
  private emoteTimers: Record<string, number> = {};
  private cache: Record<string, string> = {};

  constructor(
    private h: Handlers,
    private settings: Settings,
  ) {
    for (const el of document.querySelectorAll<HTMLElement>('.screen')) this.screens.set(el.dataset.screen!, el);

    this.screens.get('splash')!.addEventListener('click', () => h.start());

    $('stage').addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn || (btn as HTMLButtonElement).disabled) return;
      h.sound(true);
      this.act(btn.dataset.act!);
    });
    $('stage').addEventListener('mouseover', (e) => {
      const btn = (e.target as HTMLElement).closest('.btn');
      const prev = (e.relatedTarget as HTMLElement | null)?.closest?.('.btn');
      if (btn && btn !== prev) h.sound(false);
    });

    const code = $<HTMLInputElement>('code');
    code.addEventListener('input', () => {
      code.value = code.value.toUpperCase().replace(/[^A-Z]/g, '');
      this.joinError('');
    });
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.act('join-go');
    });

    $('mute').addEventListener('click', () => h.mute());
    this.bindSettings();

    for (const box of document.querySelectorAll<HTMLElement>('[data-emotes]')) {
      box.innerHTML = EMOTES.map((e, i) => `<button class="btn tiny" data-emote="${i}">${e}</button>`).join('');
    }
    $('stage').addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-emote]');
      if (btn) h.emote(Number(btn.dataset.emote));
      const seat = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-seat]');
      if (seat && !seat.disabled) {
        h.sound(true);
        h.seat(seat.dataset.seat as Seat);
      }
    });

    const name = $<HTMLInputElement>('name-input');
    name.addEventListener('input', () => (name.value = name.value.toUpperCase().replace(/[^A-Z0-9 ]/g, '')));
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.act('name-ok');
    });
    this.buildRules();

    // The arcade guide lists every power-up with its badge.
    $('guide').innerHTML = POWER_KINDS.map(
      (k) => `<div><img src="${itemUrl(k)}" alt="" /><b>${POWERS[k].name}</b><span>${POWERS[k].text}</span></div>`,
    ).join('');
  }

  /** Open a screen that has a BACK button, remembering where it was opened from. */
  private push(name: ScreenName): void {
    this.stack.push(this.screen ?? 'menu');
    this.show(name);
  }

  show(name: ScreenName | null): void {
    if (name === this.screen) return;
    this.screen = name;
    for (const [key, el] of this.screens) el.hidden = key !== name;
    if (name === 'join') $<HTMLInputElement>('code').focus();
    if (name === 'name') {
      const input = $<HTMLInputElement>('name-input');
      input.value = this.settings.name;
      input.focus();
    }
  }

  private act(act: string): void {
    switch (act) {
      case 'create':
        return this.h.create();
      case 'join':
        return this.push('join');
      case 'join-go': {
        const code = parseCode($<HTMLInputElement>('code').value);
        if (code) this.h.join(code);
        else this.joinError('A CODE IS 4 LETTERS');
        return;
      }
      case 'practice':
        return this.h.practice();
      case 'howto':
      case 'settings':
      case 'arcade':
        return this.push(act);
      case 'back':
        return this.show(this.stack.pop() ?? 'menu');
      case 'rules':
        return this.push('rules');
      case 'watch':
        return this.h.seat(null);
      case 'team-1':
        return this.h.team(1);
      case 'team-2':
        return this.h.team(2);
      case 'format-match':
        return this.h.format('match');
      case 'format-tournament':
        return this.h.format('tournament');
      case 'start-tournament':
        return this.h.startTournament();
      case 'end-tournament':
        return this.h.endTournament();
      case 'copy-watch':
        return this.h.copyWatch();
      case 'records':
        $('records-list').innerHTML = this.h
          .records()
          .map(([label, value]) => `<span class="label">${label}</span><span>${value}</span>`)
          .join('');
        return this.push('records');
      case 'name-ok':
        return this.h.named(cleanName($<HTMLInputElement>('name-input').value));
      case 'ready':
        return this.h.ready();
      case 'swap':
        return this.h.swap();
      case 'copy':
        return this.h.copy();
      case 'leave':
        return this.h.leave();
      case 'resume':
        return this.h.resume();
      case 'fullscreen':
        return toggleFullscreen();
    }
  }

  /** Set text only when it changes, so the DOM is not touched every frame. */
  private text(id: string, value: string): void {
    if (this.cache[id] === value) return;
    this.cache[id] = value;
    $(id).textContent = value;
  }

  private flag(id: string, name: string, on: boolean): void {
    const key = `${id}.${name}`;
    if (this.cache[key] === String(on)) return;
    this.cache[key] = String(on);
    $(id).classList.toggle(name, on);
  }

  private hide(id: string, hidden: boolean): void {
    const key = `${id}.hidden`;
    if (this.cache[key] === String(hidden)) return;
    this.cache[key] = String(hidden);
    $(id).hidden = hidden;
  }

  // --- join and lobby ---

  joinError(text: string): void {
    this.text('join-error', text);
  }

  setCode(code: string): void {
    $<HTMLInputElement>('code').value = code;
  }

  /** Flash COPIED on one of the two link buttons. */
  copied(watch = false): void {
    const el = $(watch ? 'copy-watch' : 'copy');
    const was = watch ? 'WATCH LINK' : 'COPY LINK';
    el.textContent = 'COPIED!';
    setTimeout(() => (el.textContent = was), 1500);
  }

  lobby(room: RoomStateMsg | null, you: Slot | null, connected: boolean, host: string): void {
    this.text('lobby-code', room?.code ?? '----');
    this.text('lobby-link', `SAME WI-FI? OPEN ${host}`);
    const players = room?.players ?? [];
    const me = players.find((p) => p.id === you) ?? null;
    const isHost = !!room && room.host === you;
    const tournament = room?.format === 'tournament';
    const seats: Seat[] = room?.team === 2 ? ['A1', 'B1', 'A2', 'B2'] : ['A1', 'B1'];
    const filled = seats.every((s) => players.some((p) => p.seat === s));

    // The seats: click an empty one to take it. A tournament has no seats to pick.
    const key = JSON.stringify([players, room?.team, tournament, you]);
    if (this.cache.seats !== key) {
      this.cache.seats = key;
      const card = (seat: Seat) => {
        const p = players.find((q) => q.seat === seat);
        const side = seat[0] === 'A' ? 'a' : 'b';
        const where = `${seat[0] === 'A' ? 'LEFT' : 'RIGHT'}${room?.team === 2 ? ` ${seat[1]}` : ' SIDE'}`;
        const streak = p && p.streak >= 2 ? `  ${p.streak} WINS IN A ROW` : '';
        const state = !p ? 'CLICK TO SIT HERE' : (p.ready ? 'READY' : 'NOT READY') + (p === me ? '  (YOU)' : '') + streak;
        return (
          `<button class="seat ${side}${p ? '' : ' empty'}" data-seat="${seat}" ${p ? 'disabled' : ''}>` +
          `<span class="where">${where}</span><span class="who">${p ? p.name : 'EMPTY'}</span>` +
          `<span class="state${p?.ready ? ' ok' : ''}">${state}</span></button>`
        );
      };
      const entrants = players.filter((p) => !p.watch);
      $('seats').innerHTML = tournament
        ? `<div class="entrants">${entrants.map((p) => `<span>${p.name}</span>`).join('')}</div>`
        : seats.map(card).join('');
      const watching = players.filter((p) => (tournament ? p.watch : !p.seat)).map((p) => p.name);
      $('watchers').textContent = watching.length ? `WATCHING: ${watching.join(', ')}` : '';
    }

    this.flag('team-1', 'on', room?.team === 1);
    this.flag('team-2', 'on', room?.team === 2);
    this.flag('format-match', 'on', !tournament);
    this.flag('format-tournament', 'on', tournament);
    for (const id of ['team-1', 'team-2', 'format-match', 'format-tournament']) {
      $<HTMLButtonElement>(id).disabled = !isHost;
    }
    $<HTMLButtonElement>('team-2').disabled = !isHost || tournament;
    this.text('rules-line', room ? describeConfig(room.config) : '');
    this.text('rules-open', isHost ? 'CHANGE RULES' : 'SEE RULES');
    this.hide('swap', tournament || room?.team === 2 || !me?.seat);
    this.hide('watch', tournament || !me?.seat);
    this.hide('ready', tournament);
    this.hide('start-tournament', !tournament || !isHost);
    const entrants = players.filter((p) => !p.watch).length;
    $<HTMLButtonElement>('start-tournament').disabled = entrants < 3;
    $<HTMLButtonElement>('ready').disabled = !me?.seat || !filled;
    this.text('ready', me?.ready ? 'NOT READY' : 'READY');

    let status: string;
    if (!connected) status = 'CONNECTING TO THE SERVER...';
    else if (!me) status = 'JOINING...';
    else if (tournament) {
      status =
        entrants < 3
          ? `A TOURNAMENT NEEDS 3 TO 8 PLAYERS. ${entrants} HERE.`
          : isHost
            ? `${entrants} PLAYERS. START WHEN EVERYONE IS IN.`
            : `${entrants} PLAYERS. WAITING FOR THE HOST TO START.`;
    } else if (!filled) status = 'SEND THE CODE OR THE LINK TO A FRIEND';
    else if (!me.seat) status = 'YOU ARE WATCHING THIS MATCH';
    else if (me.ready) status = 'WAITING FOR THE OTHERS...';
    else status = 'PRESS READY WHEN YOU ARE';
    this.text('lobby-status', status);
  }

  /** The tournament: every tie, what happens next, and the champion at the end. */
  bracket(b: BracketState, you: Slot | null, isHost: boolean, startIn: number | null): void {
    const name = (id: number | null) => (id === null ? '-' : (b.names[id] ?? '?'));
    const key = JSON.stringify([b.rounds, b.current, b.champion, you]);
    if (this.cache.bracket !== key) {
      this.cache.bracket = key;
      const titles = ['FINAL', 'SEMI-FINALS', 'QUARTER-FINALS'];
      $('bracket').innerHTML = b.rounds
        .map((round, r) => {
          const ties = round
            .map((t, i) => {
              const now = b.current?.[0] === r && b.current[1] === i;
              const line = (id: number | null, goals: number | undefined) =>
                `<span class="${t.done && t.winner === id && id !== null ? 'won' : ''}${id === you ? ' me' : ''}">` +
                `${name(id)}</span><span>${goals ?? ''}</span>`;
              return `<div class="tie${now ? ' now' : ''}">${line(t.a, t.score?.[0])}${line(t.b, t.score?.[1])}</div>`;
            })
            .join('');
          return `<div class="round"><b>${titles[b.rounds.length - 1 - r]}</b>${ties}</div>`;
        })
        .join('');
    }
    const tie = b.current ? b.rounds[b.current[0]][b.current[1]] : null;
    const playing = !!tie && (tie.a === you || tie.b === you);
    this.text('bracket-title', b.champion !== null ? 'CHAMPION!' : 'TOURNAMENT');
    this.text(
      'bracket-status',
      b.champion !== null
        ? `${name(b.champion)} WINS THE TOURNAMENT`
        : tie
          ? `NEXT: ${name(tie.a)} V ${name(tie.b)}` +
            (startIn !== null ? `   STARTS IN ${Math.ceil(startIn)}` : '')
          : 'WORKING OUT THE NEXT TIE...',
    );
    this.hide('bracket-ready', !playing || b.champion !== null);
    this.hide('end-tournament', !isHost);
  }
  // --- in play ---

  hud(
    v: {
      /** Null for someone watching. */
      side: Side | null;
      score: Record<Side, number>;
      clockMs: number;
      golden: boolean;
      names: Record<Side, string>;
      series: Series;
      seriesScore: Record<Side, number>;
    } | null,
  ): void {
    this.hide('hud', !v);
    this.hide('arrow', !v);
    if (!v) return;
    this.text('score-a', String(v.score.A));
    this.text('score-b', String(v.score.B));
    this.text('name-a', v.names.A);
    this.text('name-b', v.names.B);
    this.flag('name-a', 'me', v.side === 'A');
    this.flag('name-b', 'me', v.side === 'B');
    const secs = Math.ceil(v.clockMs / 1000);
    this.text('clock', v.golden ? 'GOLDEN' : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
    this.flag('clock', 'late', v.golden || secs <= 60);
    const pips = (n: number) => (v.series === 3 ? '*'.repeat(n) + '-'.repeat(Math.max(0, 2 - n)) : '');
    this.text('pips-a', pips(v.seriesScore.A));
    this.text('pips-b', pips(v.seriesScore.B));
    this.text('arrow', v.side === 'A' ? 'OPPONENT >' : v.side === 'B' ? '< OPPONENT' : '');
    this.flag('arrow', 'to-right', v.side === 'A');
    this.flag('arrow', 'to-left', v.side === 'B');
  }

  /** Super meters, the modifier panel and each player's power-up chips; null hides them. */
  arcadeHud(v: ArcadeHud | null): void {
    this.hide('arcade-hud', !v);
    this.hide('chips-a', !v);
    this.hide('chips-b', !v);
    if (!v) return;

    for (const [id, level] of [
      ['meter-a', v.meterA],
      ['meter-b', v.meterB],
    ] as const) {
      const pct = `${Math.round(level * 100)}%`;
      if (this.cache[id] !== pct) {
        this.cache[id] = pct;
        $(id).style.width = pct;
        const full = level >= 1;
        $(id).parentElement!.classList.toggle('full', full);
        $(`${id}-label`).textContent = full ? 'FIREBALL READY!' : `SUPER ${pct}`;
      }
    }

    this.text('mod-label', v.mod.label);
    this.flag('mod', 'now', v.mod.state === 'now');
    this.flag('mod', 'soon', v.mod.state === 'soon');
    this.width('mod-bar', v.mod.share);
    this.text('grow', v.grow);
    this.chips('chips-a', v.chipsA);
    this.chips('chips-b', v.chipsB);
  }

  private width(id: string, share: number): void {
    const pct = `${Math.max(0, Math.min(100, Math.round(share * 100)))}%`;
    const key = `${id}.w`;
    if (this.cache[key] === pct) return;
    this.cache[key] = pct;
    $(id).style.width = pct;
  }

  private chips(id: string, chips: Chip[]): void {
    const root = $(id);
    // Rebuild only when the set of chips changes; timers update in place.
    const shape = chips.map((c) => c.kind + (c.bad ? '!' : '')).join(',');
    if (this.cache[`${id}.shape`] !== shape) {
      this.cache[`${id}.shape`] = shape;
      for (let i = 0; i < 12; i++) delete this.cache[`${id}.${i}`];
      root.innerHTML = chips
        .map(
          (c) =>
            `<div class="chip-fx${c.bad ? ' bad' : ''}"><img src="${itemUrl(c.kind)}" alt="" />` +
            `<span class="name">${POWERS[c.kind].name}</span><div class="bar"><i></i></div>` +
            `<span class="secs"></span></div>`,
        )
        .join('');
    }
    chips.forEach((c, i) => {
      const el = root.children[i] as HTMLElement;
      const secs = c.secs === null ? 'READY' : `${Math.ceil(c.secs)}S`;
      const key = `${id}.${i}`;
      const val = `${secs}|${Math.round(c.share * 50)}`;
      if (this.cache[key] === val) return;
      this.cache[key] = val;
      el.querySelector('.secs')!.textContent = secs;
      el.querySelector<HTMLElement>('.bar i')!.style.width = `${Math.round(c.share * 100)}%`;
    });
  }

  /** A notice under the scoreboard: what is coming, or what someone just got. */
  banner(title: string, text: string, icon: ItemKind | null = null, holdMs = 2000): void {
    const el = $('banner');
    $('banner-title').textContent = title;
    $('banner-text').textContent = text;
    const img = $<HTMLImageElement>('banner-icon');
    img.hidden = !icon;
    if (icon) img.src = itemUrl(icon);
    el.hidden = true;
    void el.offsetWidth;
    el.hidden = false;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => (el.hidden = true), holdMs);
  }

  /** A speech bubble by one player's score, or in the middle for someone watching. */
  emote(side: Side | null, name: string, text: string): void {
    const el = $(side === 'A' ? 'emote-a' : side === 'B' ? 'emote-b' : 'emote-c');
    el.textContent = side ? text : `${name}: ${text}`;
    el.hidden = true;
    void el.offsetWidth;
    el.hidden = false;
    const slot = side ?? 'C';
    clearTimeout(this.emoteTimers[slot]);
    this.emoteTimers[slot] = window.setTimeout(() => (el.hidden = true), 1800);
  }

  // --- match rules ---

  /** One row per rule, each a set of buttons. Built once; ules() then marks the current choices. */
  private buildRules(): void {
    const yesNo: [unknown, string][] = [
      [true, 'ON'],
      [false, 'OFF'],
    ];
    const rows: [string, keyof Config, [unknown, string][]][] = [
      ['PRESET', 'preset', [['arcade', 'ARCADE'], ['classic', 'CLASSIC'], ['custom', 'CUSTOM']]],
      ['LENGTH', 'minutes', MINUTES.map((m) => [m, `${m} MIN`])],
      ['GOALS TO WIN', 'goals', GOALS.map((g) => [g, String(g)])],
      ['SERIES', 'series', [[1, 'SINGLE'], [3, 'BEST OF 3']]],
      ['ARENA', 'arena', ARENA_CHOICES.map((a) => [a, a === 'random' ? 'RANDOM' : ARENAS[a].name])],
      ['GOALKEEPER', 'keeper', KEEPER_LEVELS.map((k) => [k, k.toUpperCase()])],
      ['POWER-UPS', 'powerups', yesNo],
      ['MODIFIERS', 'modifiers', yesNo],
      ['HAZARDS', 'hazards', yesNo],
      ['GROWING GOALS', 'growing', yesNo],
      ['FINAL FRENZY', 'frenzy', yesNo],
    ];
    const form = $('rules-form');
    form.innerHTML = rows
      .map(
        ([label, key, options]) =>
          `<span class="label">${label}</span><div class="opts">` +
          options
            .map(([v, text]) => `<button class="btn tiny toggle" data-rule="${key}" data-value='${JSON.stringify(v)}'>${text}</button>`)
            .join('') +
          '</div>',
      )
      .join('');
    form.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-rule]');
      if (!btn || btn.disabled || btn.dataset.value === '"custom"') return;
      this.h.sound(true);
      this.h.config({ [btn.dataset.rule!]: JSON.parse(btn.dataset.value!) });
    });
  }

  rules(config: Config, editable: boolean): void {
    const key = JSON.stringify(config) + editable;
    if (this.cache.rules === key) return;
    this.cache.rules = key;
    $('rules-who').textContent = editable ? 'YOU SET THE RULES' : 'ONLY THE PLAYER WHO MADE THE MATCH CAN CHANGE THESE';
    for (const btn of $('rules-form').querySelectorAll<HTMLButtonElement>('[data-rule]')) {
      const k = btn.dataset.rule as keyof Config;
      btn.classList.toggle('on', JSON.stringify(config[k]) === btn.dataset.value);
      btn.disabled = !editable;
    }
  }

  practiceHud(text: string | null): void {
    this.hide('practice-hud', text === null);
    if (text !== null) this.text('practice-hud', text);
  }

  /** undefined hides the icon; null means no reading yet. */
  signal(rtt: number | null | undefined): void {
    this.hide('signal', rtt === undefined);
    if (rtt === undefined) return;
    const level = rtt === null ? 0 : rtt > 500 ? 1 : rtt > 250 ? 2 : 3;
    const el = $('signal');
    if (this.cache.sigLevel !== String(level)) {
      this.cache.sigLevel = String(level);
      el.dataset.level = String(level);
      el.style.setProperty('--tint', level === 3 ? 'var(--green)' : level === 2 ? 'var(--yellow)' : 'var(--red)');
    }
    const label = rtt === null ? '' : `${Math.round(rtt)}MS`;
    if (this.cache.sigText !== label) {
      this.cache.sigText = label;
      el.querySelector('span')!.textContent = label;
    }
  }

  muted(m: boolean): void {
    $('mute').classList.toggle('off', m);
  }

  /** `large` is for moments when play has stopped; everything else stays small and out of the way. */
  callout(big: string, sub = '', colour = 'var(--ink)', holdMs = 1700, large = false): void {
    const el = $('callout');
    const b = el.querySelector<HTMLElement>('.big')!;
    b.textContent = big;
    b.classList.toggle('large', large);
    b.style.color = colour;
    el.querySelector('.sub')!.textContent = sub;
    // Restart the slam animation.
    el.hidden = true;
    void el.offsetWidth;
    el.hidden = false;
    clearTimeout(this.calloutTimer);
    this.calloutTimer = window.setTimeout(() => (el.hidden = true), holdMs);
  }

  /** Big countdown number; null hides it. */
  count(text: string | null): void {
    const el = $('count');
    if (this.cache.count === String(text)) return;
    this.cache.count = String(text);
    el.hidden = text === null;
    if (text === null) return;
    el.textContent = text;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  /** Server-side pause overlay; null hides it. */
  wait(title: string | null, text = ''): void {
    this.hide('wait', title === null);
    if (title === null) return;
    this.text('wait-title', title);
    this.text('wait-text', text);
  }

  pauseMenu(practice: boolean): void {
    this.text('pause-title', practice ? 'PAUSED' : 'MENU');
    this.text('pause-text', practice ? '' : 'THE MATCH IS STILL RUNNING');
    this.text('pause-leave', practice ? 'QUIT PRACTICE' : 'LEAVE MATCH');
  }

  // --- full time ---

  fullTime(
    r: FullTimeMsg,
    /** Null for someone watching. */
    side: Side | null,
    series: Series,
    me: boolean,
    mate: boolean | null,
    names: Record<Side, string>,
    news: string[],
    /** A tournament moves on by itself, so there is no rematch to ask for. */
    tournament: boolean,
  ): void {
    const won = r.winner === side;
    const key = JSON.stringify(r) + side + news.join();
    if (this.cache.ft !== key) {
      this.cache.ft = key;
      const banner = $('ft-banner');
      banner.textContent = !side ? `${names[r.winner]} WINS` : won ? 'YOU WIN!' : 'YOU LOSE';
      banner.classList.toggle('win', won);
      const name = (s: Side) => names[s];
      $('ft-news').textContent = news.length ? `NEW RECORD!  ${news.join('   ')}` : '';
      $('ft-score').innerHTML =
        `<span class="a">${name('A')} ${r.score.A}</span> - <span class="b">${r.score.B} ${name('B')}</span>`;
      $('ft-series').textContent = r.forfeit
        ? won
          ? 'YOUR FRIEND LEFT THE MATCH'
          : 'YOU LEFT THE MATCH'
        : series === 3
          ? `SERIES ${r.seriesScore.A} - ${r.seriesScore.B}${r.seriesOver ? '' : '   NEXT GAME COMING UP'}`
          : '';

      const rows: [string, keyof PlayerStats, (n: number) => string][] = [
        ['GOALS', 'goals', String],
        ['SHOTS', 'shots', String],
        ['FASTEST SHOT', 'fastest', (n) => `${kmh(n)} KM/H`],
        ['SAVES', 'saves', String],
        ['POSSESSION', 'possession', (n) => `${n}%`],
        ['BEST JUGGLE', 'juggle', String],
        ['KEEPER SAVES', 'keeper', String],
      ];
      const cell = (cls: string, text: string) => `<span class="${cls}">${text}</span>`;
      $('ft-stats').innerHTML = rows
        .map(([label, k, fmt]) => {
          const a = r.stats.A[k];
          const b = r.stats.B[k];
          return (
            cell(a > b ? 'best' : 'a', fmt(a)) + cell('label', label) + cell(b > a ? 'best' : 'b', fmt(b))
          );
        })
        .join('');
    }

    this.text('ft-again', me ? 'CANCEL' : r.seriesOver ? 'REMATCH' : 'NEXT GAME');
    $<HTMLButtonElement>('ft-again').disabled = mate === null;
    this.hide('ft-again', tournament || !side);
    const what = r.seriesOver ? 'A REMATCH' : 'THE NEXT GAME';
    this.text(
      'ft-status',
      tournament
        ? 'BACK TO THE BRACKET IN A MOMENT...'
        : !side
          ? ''
          : mate === null
        ? 'YOUR FRIEND HAS LEFT'
        : me && !mate
          ? 'WAITING FOR YOUR FRIEND...'
          : mate && !me
            ? `YOUR FRIEND WANTS ${what}!`
            : '',
    );
  }

  // --- settings ---

  private bindSettings(): void {
    const s = this.settings;
    const range = (id: string, key: 'sensitivity' | 'sfx' | 'music') => {
      const el = $<HTMLInputElement>(id);
      el.value = String(s[key]);
      el.addEventListener('input', () => {
        s[key] = Number(el.value);
        this.h.settingsChanged();
      });
    };
    const toggle = (id: string, key: 'shake' | 'flashes' | 'lock' | 'emotes') => {
      const el = $(id);
      const paint = () => {
        el.textContent = s[key] ? 'ON' : 'OFF';
        el.classList.toggle('on', s[key]);
      };
      el.addEventListener('click', () => {
        s[key] = !s[key];
        paint();
        this.h.sound(true);
        this.h.settingsChanged();
      });
      paint();
    };
    range('set-sensitivity', 'sensitivity');
    range('set-sfx', 'sfx');
    range('set-music', 'music');
    toggle('set-shake', 'shake');
    toggle('set-flashes', 'flashes');
    toggle('set-lock', 'lock');
    toggle('set-emotes', 'emotes');
    const name = $<HTMLInputElement>('set-name');
    name.value = s.name;
    name.addEventListener('input', () => {
      name.value = name.value.toUpperCase().replace(/[^A-Z0-9 ]/g, '');
      s.name = cleanName(name.value);
      this.h.settingsChanged();
    });
  }
}
