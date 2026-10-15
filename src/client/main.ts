import '@fontsource/press-start-2p';
import './ui/style.css';
import { DT, HALF_X, ROOF_Y, SERVER_PORT, VIEW_W, WORLD_W, tuning } from '../shared/constants';
import { ARENAS } from '../shared/arena';
import { EMOTES } from '../shared/config';
import { ARCADE, MODS, POWERS, isHazard, isPower } from '../shared/effects';
import { FootTracker } from '../shared/foot';
import type { EventMsg, Phase, ServerMsg } from '../shared/protocol';
import { parseCode } from '../shared/rules';
import { other, type Ball, type Side, type SimEvent } from '../shared/types';
import { Sfx } from './audio';
import { DebugPanel } from './debug';
import { Renderer, plainFrame, type DrawBall, type Frame } from './gfx/renderer';
import { TEAM } from './gfx/sprites';
import { Input } from './input';
import { MatchClient, type Intent } from './match';
import { Net } from './net';
import { Practice } from './practice';
import { loadRecords, recordGame, recordPickup, recordRows, recordTournament } from './records';
import { loadSettings, saveSettings } from './settings';
import { Howto } from './ui/howto';
import { UI, toggleFullscreen, type ArcadeHud, type Chip } from './ui/ui';
import { View } from './view';

const KICK_SOUND_GAP_MS = 70;
const HITSTOP_S = 0.05;
const YELLOW = 'var(--yellow)';
const IDLE_LED = 'SPLIT-SCREEN FOOTBALL    TWO SCREENS   ONE PITCH   NO CLICKS';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const out = canvas.getContext('2d')!;

const settings = loadSettings();
const records = loadRecords();
/** Personal bests set by the game that has just finished. */
let news: string[] = [];
let arenaShownFor = -1;
const view = new View(canvas);
const input = new Input(canvas, view);
const sfx = new Sfx();
const renderer = new Renderer();
/** Someone watching sees both halves, so they need a second picture. */
const rendererB = new Renderer();
const debug = new DebugPanel(document.getElementById('debug')!);
const howto = new Howto(document.getElementById('demos')!);
const tracker = new FootTracker(VIEW_W / 2, 6);
/** A teammate's boot, when this screen runs a half in 2 v 2. */
const mateTracker = new FootTracker(VIEW_W / 2, 6);
let championSeen = false;
const events: SimEvent[] = [];

let mode: 'idle' | 'practice' | 'match' = 'idle';
let practice: Practice | null = null;
let match: MatchClient | null = null;
let net: Net | null = null;
/** A ball that kicks itself about behind the menus. */
let attract = new Practice();
let attractRest = 0;

let last = performance.now();
let time = 0;
let acc = 0;
let hitstop = 0;
let lastKickSound = 0;
let lastCount: number | null = null;
let ledUntil = 0;
let buzz = 0;
let lastSide: Side | null = null;

const ui = new UI(
  {
    start() {
      sfx.unlock();
      applySettings();
      sfx.music(true);
      // First visit: ask what to call them.
      if (!settings.name) ui.show('name');
      else enter();
    },
    named(name) {
      settings.name = name;
      saveSettings(settings);
      enter();
    },
    config: (patch) => match?.setConfig(patch),
    emote(id) {
      if (settings.emotes) match?.sendEmote(id);
    },
    records: () => recordRows(records),
    create: () => startMatch({ type: 'create' }),
    join: joinRoom,
    practice() {
      mode = 'practice';
      practice = new Practice();
      view.setSide('A');
      tracker.reset(VIEW_W / 2, 6);
      ui.show(null);
      enterPlay();
      sfx.whistle();
    },
    ready() {
      const me = match?.me;
      if (me) match!.setReady(!me.ready);
    },
    swap() {
      if (match?.side) match.setSide(other(match.side));
    },
    seat: (seat) => match?.setSeat(seat),
    team: (size) => net?.send({ type: 'set_team', size }),
    format: (format) => net?.send({ type: 'set_format', format }),
    startTournament: () => net?.send({ type: 'start_tournament' }),
    endTournament: () => net?.send({ type: 'end_tournament' }),
    copyWatch() {
      if (!match?.code) return;
      const link = `${location.protocol}//${shareHost()}${location.pathname}?room=${match.code}&watch=1`;
      void copyText(link).then((ok) => ok && ui.copied(true));
    },
    leave,
    resume() {
      ui.show(null);
      if (settings.lock) input.requestLock();
    },
    copy() {
      if (!match?.code) return;
      const link = `${location.protocol}//${shareHost()}${location.pathname}?room=${match.code}`;
      void copyText(link).then((ok) => ok && ui.copied());
    },
    mute() {
      settings.muted = !settings.muted;
      saveSettings(settings);
      applySettings();
    },
    settingsChanged() {
      saveSettings(settings);
      applySettings();
    },
    sound: (confirm) => sfx.blip(confirm),
  },
  settings,
);

/** Past the splash and the name: into a room if the link named one, else the menu. */
function enter(): void {
  const query = new URLSearchParams(location.search);
  const code = parseCode(query.get('room') ?? '');
  if (code) joinRoom(code, query.has('watch'));
  else ui.show('menu');
}

function applySettings(): void {
  tuning.sensitivity = settings.sensitivity;
  sfx.setVolumes(settings.sfx, settings.music, settings.muted);
  renderer.shakeOn = settings.shake;
  renderer.flashesOn = settings.flashes;
  ui.muted(settings.muted);
}

/** The game itself has the screen: no menu is open over it. */
const inPlay = () => mode !== 'idle' && ui.screen === null;

function enterPlay(): void {
  canvas.classList.add('playing');
  sfx.music(false);
  if (settings.lock) input.requestLock();
}

function exitPlay(): void {
  canvas.classList.remove('playing');
  input.releaseLock();
  sfx.music(true);
}

function openPause(): void {
  if (!inPlay() || debug.open) return;
  ui.pauseMenu(mode === 'practice');
  ui.show('pause');
}

// --- match plumbing ---

const tokenKey = (code: string) => `ssf-room-${code}`;

/**
 * Address a friend on the same network can reach. "localhost" only works on
 * this computer, so swap in its network address when the server has told us it.
 */
function shareHost(): string {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const host = local && match?.lan ? match.lan : location.hostname;
  return location.port ? `${host}:${location.port}` : host;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The clipboard API needs https or localhost; a friend on http://10.x falls back to this.
    const box = document.createElement('textarea');
    box.value = text;
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.append(box);
    box.select();
    const ok = document.execCommand('copy');
    box.remove();
    return ok;
  }
}

function joinRoom(code: string, watch = false): void {
  let token: string | undefined;
  try {
    token = sessionStorage.getItem(tokenKey(code)) ?? undefined;
  } catch {
    /* storage unavailable */
  }
  ui.setCode(code);
  startMatch({ type: 'join', code, token, watch });
}

function startMatch(intent: Intent): void {
  closeMatch();
  mode = 'match';
  lastSide = null;
  championSeen = false;
  const who = { name: settings.name, streak: records.streak };
  const client = new MatchClient((m) => net?.send(m), intent, undefined, undefined, undefined, who);
  client.onPhase = onPhase;
  client.onEvent = onEvent;
  client.onEmote = (side, name, id) => {
    if (!settings.emotes) return;
    ui.emote(side, name, EMOTES[id] ?? '');
    sfx.blip(true);
  };
  client.onBlast = (x, y) => {
    renderer.sparkle(x, y, '#ff5c5c');
    renderer.addShake(0.7);
    sfx.fire();
  };
  match = client;
  net = new Net(gameServerUrl(), onServer, () => client.open());
  ui.show('lobby');
}

/**
 * Where the game server is. A deployed build is told by VITE_GAME_SERVER (for
 * example wss://my-game.onrender.com); otherwise it is on the same computer as the page.
 */
function gameServerUrl(): string {
  const set = import.meta.env.VITE_GAME_SERVER as string | undefined;
  if (set) return set;
  const secure = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${secure}://${location.hostname}:${SERVER_PORT}`;
}

function closeMatch(): void {
  net?.close();
  net = null;
  match = null;
}

function leave(): void {
  if (mode === 'match') {
    match?.leave();
    closeMatch();
    history.replaceState(null, '', location.pathname);
  }
  mode = 'idle';
  practice = null;
  view.setWide(false);
  view.setSide('A');
  attract = new Practice();
  ui.show('menu');
  exitPlay();
}

function onServer(m: ServerMsg): void {
  const client = match;
  if (!client) return;
  client.onMessage(m);

  if (m.type === 'joined') {
    try {
      sessionStorage.setItem(tokenKey(m.code), m.token);
    } catch {
      /* storage unavailable */
    }
    history.replaceState(null, '', `?room=${m.code}`);
  } else if (m.type === 'error') {
    closeMatch();
    mode = 'idle';
    history.replaceState(null, '', location.pathname);
    ui.show('join');
    ui.joinError(m.reason === 'full' ? 'THAT MATCH IS ALREADY FULL' : 'NO MATCH WITH THAT CODE');
  } else if (m.type === 'room_state') {
    if (client.watching) view.setSide('A');
    if (client.side && client.side !== lastSide) {
      lastSide = client.side;
      view.setSide(client.side);
      tracker.reset(view.x0 + VIEW_W / 2, 6);
    }
    if (!client.side) lastSide = null;
    // The lobby gives way to the bracket while a tournament runs.
    const want = m.bracket ? 'bracket' : 'lobby';
    if ((ui.screen === 'lobby' || ui.screen === 'bracket') && ui.screen !== want) ui.show(want);
    if (m.bracket?.champion === client.you && !championSeen) {
      championSeen = true;
      recordTournament(records);
      sfx.fanfare(true);
    }
  }
}

function onPhase(phase: Phase, prev: Phase | null): void {
  if (phase === 'lobby') {
    const want = match?.room?.bracket ? 'bracket' : 'lobby';
    if (ui.screen !== want) {
      ui.show(want);
      exitPlay();
    }
  } else if (phase === 'full_time') {
    ui.show('fulltime');
    exitPlay();
    sfx.whistle(3);
    news = [];
    setTimeout(() => {
      if (!match?.result || !match.side) return;
      sfx.fanfare(match.result.winner === match.side);
      // Records are personal: only the player running a half has the numbers for them.
      if (match.runs) news = recordGame(records, match.result, match.side);
    }, 1500);
  } else {
    // Any live phase: make sure the game has the screen.
    if (ui.screen === 'lobby' || ui.screen === 'fulltime' || ui.screen === 'bracket') {
      ui.show(null);
      enterPlay();
    }
    if (phase === 'countdown') lastCount = null;
    if (phase === 'playing' && prev === 'countdown') {
      sfx.beep(true);
      sfx.whistle();
      // Name the arena at the first kickoff of each game.
      const a = match?.arcade;
      const game = match?.state?.game ?? 0;
      if (a && a.arena !== 'none' && game !== arenaShownFor) {
        arenaShownFor = game;
        ui.banner(ARENAS[a.arena].name, ARENAS[a.arena].text, null, 3200);
      }
    }
  }
}

function onEvent(e: EventMsg): void {
  if (!match) return;
  // Null for someone watching, who is told things by name.
  const side = match.side;
  const who = 'side' in e ? match.nameOf(e.side) : '';
  switch (e.kind) {
    case 'goal': {
      const mine = e.side === side;
      const speed = e.speed > 0 ? `${Math.round(e.speed * 3.6)} KM/H` : '';
      const sub = [e.points > 1 ? 'COUNTS DOUBLE!' : '', e.screamer ? 'SCREAMER!' : '', speed].filter(Boolean).join('  ');
      ui.callout(!side ? `${who} SCORES!` : mine ? 'GOAL!' : 'CONCEDED', sub, TEAM[e.side].light, 1900, true);
      sfx.roar();
      renderer.celebrate(e.side);
      renderer.addShake(0.6);
      if (e.screamer) renderer.addFlash();
      ledUntil = time + 3;
      buzz = 1;
      break;
    }
    case 'save':
      ui.callout(e.side === side ? 'WHAT A SAVE!' : 'SAVED!', '', TEAM[e.side].light, 1100);
      sfx.ooh();
      renderer.gasp();
      buzz = 0.7;
      break;
    case 'bar':
      ui.callout('OFF THE BAR!', '', YELLOW, 1100);
      sfx.ooh();
      renderer.gasp();
      buzz = 0.7;
      break;
    case 'stall':
      sfx.whistle();
      if (!side) ui.callout('STALLING', `${who} LOSES THE BALL`, YELLOW);
      else if (e.side === side) ui.callout('TOO SLOW!', 'THE BALL GOES TO THE OTHER SIDE', YELLOW);
      else ui.callout('STALLING', 'THE BALL IS YOURS', YELLOW);
      break;
    case 'golden':
      ui.callout('GOLDEN GOAL', 'NEXT GOAL WINS', YELLOW, 2500);
      sfx.whistle(2);
      break;
    case 'last_minute':
      ui.callout('LAST MINUTE', '', YELLOW, 1300);
      break;
    case 'match_point':
      ui.callout('MATCH POINT', e.side === side ? 'ONE MORE TO WIN' : 'DEFEND!', TEAM[e.side].light, 1500);
      break;

    // --- arcade: always say what is coming and what someone got ---
    case 'pickup': {
      const who = `${match?.nameOf(e.side) || 'SOMEONE'} GOT`;
      if (isHazard(e.item)) {
        // A mine went off on that player's half.
        ui.banner('BOOM!', `A MINE ON ${match?.nameOf(e.side)}'S SIDE`, e.item, 1600);
        break;
      }
      if (isPower(e.item)) {
        const info = POWERS[e.item];
        ui.banner(`${who} ${info.name}`, info.text, e.item);
        // Things done to me get their own sound.
        if (e.item === 'freeze' && e.side !== side) sfx.freeze();
        if (e.side === side) recordPickup(records, e.item);
      } else {
        ui.banner(`${who} THE TARGET`, 'HALF A SUPER METER', 'target');
      }
      sfx.pickup();
      break;
    }
    case 'keeper':
      ui.banner('KEEPER SAVE', `${match?.nameOf(e.side)}'S KEEPER GOT TO IT`, null, 1400);
      renderer.gasp();
      break;
    case 'fire':
      if (e.side === side) ui.callout('FIREBALL!', '', '#ff8a2a', 1100);
      else if (!side) ui.banner(`${who}: FIREBALL!`, '', 'fireball', 1600);
      else ui.banner('FIREBALL INCOMING', 'BLOCK IT AND YOUR BOOT IS STUNNED', 'fireball', 1600);
      break;
    case 'stun':
      if (e.side === side) ui.callout('STUNNED!', '', YELLOW, 900);
      else if (!side) ui.banner(`${who} IS STUNNED`, '', null, 1400);
      else ui.banner('YOU STUNNED THEM', 'SHOOT NOW', null, 1400);
      break;
    case 'mod_soon':
      ui.banner(`NEXT: ${MODS[e.mod].name}`, 'STARTS IN 5 SECONDS', null, 3000);
      sfx.sting();
      break;
    case 'mod':
      ui.callout(MODS[e.mod].name, MODS[e.mod].text, YELLOW, 1800);
      sfx.sting();
      break;
    case 'grow':
      ui.banner('GOALS GROW', `NOW ${e.goalH} METRES TALL`, 'biggoal');
      sfx.sting();
      break;
    case 'frenzy_soon':
      ui.banner('FINAL FRENZY', 'STARTS IN 5 SECONDS', 'multiball', 3000);
      break;
    case 'frenzy':
      ui.callout('FINAL FRENZY', 'TWO BALLS. GOALS COUNT DOUBLE.', '#ff5c5c', 2400);
      sfx.siren();
      break;
  }
}

// --- input wiring ---

input.onLockChange = (locked) => {
  // Esc releases the pointer; treat that as opening the menu.
  if (!locked && settings.lock) openPause();
};

canvas.addEventListener('pointerdown', () => {
  if (inPlay() && settings.lock) input.requestLock();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Backquote') {
    debug.toggle();
    if (debug.open) input.releaseLock();
  } else if (e.code === 'KeyM' && (e.target as HTMLElement).tagName !== 'INPUT') {
    settings.muted = !settings.muted;
    saveSettings(settings);
    applySettings();
  } else if (/^Digit[1-6]$/.test(e.code) && mode === 'match' && (e.target as HTMLElement).tagName !== 'INPUT') {
    if (settings.emotes) match?.sendEmote(Number(e.code.slice(5)) - 1);
  } else if (e.code === 'KeyF' && (e.target as HTMLElement).tagName !== 'INPUT') {
    toggleFullscreen();
  } else if (e.code === 'Escape') {
    if (ui.screen === 'pause') {
      ui.show(null);
      if (settings.lock) input.requestLock();
    } else if (!input.locked) {
      openPause();
    }
  }
});

document.addEventListener('visibilitychange', () => {
  if (mode === 'match') match?.setAway(document.hidden);
});

debug.attachNet(() => net);

// In development the current match can be inspected from the browser console as `ssf.match`.
if (import.meta.env.DEV) {
  Object.defineProperty(window, 'ssf', { value: { get match() { return match; } } });
}

// --- the loop ---

function simulate(dt: number): void {
  if (inPlay()) {
    const p = input.read(tracker, tuning.sensitivity);
    if (p.jump) tracker.reset(p.x, p.y);
    else tracker.update(p.x, p.y, dt, tuning);
  } else {
    tracker.update(tracker.x, tracker.y, dt, tuning);
  }

  acc += dt;
  const n = Math.floor(acc / DT);
  acc -= n * DT;
  // In 2 v 2 the runner of a half also moves their teammate's boot, from where it was last reported.
  const mate = match?.runs && match.mate && performance.now() - match.mate.at < 500 ? match.mate : null;
  if (mate) mateTracker.update(mate.x, mate.y, dt, tuning);
  if (match) match.myFoot = inPlay() ? { x: tracker.x, y: tracker.y, vx: tracker.vx, vy: tracker.vy } : null;

  for (let i = 0; i < n; i++) {
    const sweep = inPlay() ? tracker.sweep(i, n) : null;
    if (practice) practice.step(sweep, events);
    else match?.step(sweep, events, mate ? mateTracker.sweep(i, n) : null);
  }
  if (n > 0) {
    tracker.commit();
    mateTracker.commit();
  }
}

/** Menu backdrop: nudge the ball whenever it comes to rest. */
function runAttract(dt: number): void {
  acc += dt;
  const n = Math.floor(acc / DT);
  acc -= n * DT;
  for (let i = 0; i < n; i++) attract.step(null, events);
  const b = attract.ball;
  if (b.onGround && Math.abs(b.vx) < 0.5) {
    attractRest += dt;
    if (attractRest > 0.7) {
      attractRest = 0;
      b.vx = (b.x > 25 ? -1 : 1) * (10 + Math.random() * 18);
      b.vy = 8 + Math.random() * 16;
    }
  }
}

/** Sounds and effects for what the simulation just did. */
function react(): void {
  const now = performance.now();
  const quiet = mode === 'idle';
  for (const e of events) {
    if (e.type === 'kick') {
      renderer.onKick(Math.min(1, e.power / 25), e.x, e.y, e.vx, e.vy);
      if (!quiet && now - lastKickSound > KICK_SOUND_GAP_MS) {
        lastKickSound = now;
        sfx.kick(e.power / 25);
      }
      // A brief freeze sells a full-power shot.
      if (e.power > 15 && e.speed >= tuning.maxShot * 0.92) {
        hitstop = HITSTOP_S;
        renderer.addShake(0.5);
        buzz = Math.max(buzz, 0.5);
      }
    } else if (e.type === 'bounce') {
      renderer.onBounce(e.kind, e.speed, e.x, e.y);
      if (!quiet) sfx.bounce(e.kind, e.speed);
    } else if (e.type === 'bumper') {
      renderer.onBumper(e.x, e.y);
      sfx.boing();
    } else if (e.type === 'pad') {
      renderer.onPad(e.x);
      sfx.spring();
    } else if (e.type === 'keeper') {
      renderer.sparkle(e.x, e.y, '#ffd23f');
      sfx.bounce('wall', 22);
    } else if (e.type === 'portal') {
      renderer.sparkle(e.x, e.y, '#c77dff');
      sfx.warp();
    } else if (e.type === 'fire') {
      sfx.fire();
      renderer.addShake(0.6);
    } else if (e.type === 'stun') {
      sfx.stunned();
      renderer.addShake(0.4);
    } else if (!quiet) {
      // Practice: a goal scored off the wall.
      sfx.roar();
      renderer.celebrate('A');
      renderer.addShake(0.5);
      ui.callout('GOAL!', 'OFF THE WALL', TEAM.A.light, 1300, true);
      buzz = 1;
    }
  }
  events.length = 0;
}

/** How far from the goal a ghost ball starts to show, and over what distance it fades in. */
const GHOST_SHOWS_AT = 20;
const GHOST_FADE = 6;

function toDraw(b: Ball, alpha: number, side: Side): DrawBall {
  const x = b.px + (b.x - b.px) * alpha;
  const fromGoal = side === 'A' ? x : WORLD_W - x;
  return {
    x,
    y: b.py + (b.y - b.py) * alpha,
    angle: b.angle,
    speed: Math.hypot(b.vx, b.vy),
    fire: b.fire,
    alpha: b.ghost ? Math.max(0, Math.min(1, (GHOST_SHOWS_AT - fromGoal) / GHOST_FADE)) : 1,
  };
}

/** "0:12" style countdown for the HUD. */
const secs = (ms: number) => String(Math.max(0, Math.ceil(ms / 1000)));

const kmh = (ms: number) => Math.round(ms * 3.6);

/** What the Arcade HUD shows, worked out from the match state. */
function arcadeHud(m: MatchClient): ArcadeHud | null {
  const a = m.arcade;
  if (!a) return null;
  const el = m.playSince();

  const mod = m.modNow();
  let panel: ArcadeHud['mod'];
  if (a.frenzy) {
    panel = { label: 'FRENZY: DOUBLE GOALS', share: 1, state: 'now' };
  } else if (mod?.running) {
    panel = { label: `NOW: ${MODS[mod.kind].name}  ${secs(mod.secs * 1000)}`, share: mod.share, state: 'now' };
  } else if (mod) {
    panel = { label: `NEXT: ${MODS[mod.kind].name} IN ${secs(mod.secs * 1000)}`, share: 0, state: 'soon' };
  } else if (a.nextModInMs !== null) {
    panel = { label: `NEXT EVENT IN ${secs(a.nextModInMs - el + ARCADE.modWarnMs)}`, share: 0, state: 'idle' };
  } else if (a.frenzyInMs !== null) {
    panel = { label: `FRENZY IN ${secs(a.frenzyInMs - el)}`, share: 0, state: a.frenzyInMs - el < 5000 ? 'soon' : 'idle' };
  } else {
    panel = { label: 'GOLDEN GOAL', share: 0, state: 'idle' };
  }

  const chips = (who: Side, meter: number, ghost: boolean): Chip[] => {
    const list: Chip[] = m.effectsOn(who).map((e) => ({
      kind: e.kind,
      secs: e.secs,
      share: e.share,
      bad: POWERS[e.kind].on === 'them',
    }));
    // One-shot power-ups wait until they are used.
    if (meter >= 1) list.push({ kind: 'fireball', secs: null, share: 1, bad: false });
    if (ghost) list.push({ kind: 'ghost', secs: null, share: 1, bad: false });
    return list;
  };
  const forA = m.meterOf('A');
  const forB = m.meterOf('B');

  return {
    meterA: forA.v,
    meterB: forB.v,
    mod: panel,
    grow: a.growInMs === null ? `GOALS ${Math.round(a.goalH)} M` : `GOALS GROW IN ${secs(a.growInMs - el)}`,
    chipsA: chips('A', forA.v, forA.ghost),
    chipsB: chips('B', forB.v, forB.ghost),
  };
}

/** Fill a frame with one half of a match, either from this screen's own simulation or from its runner's description. */
function drawHalf(f: Frame, m: MatchClient, side: Side, alpha: number, ownFoot: boolean): void {
  const st = m.state;
  const t = m.tuningOf(side);
  const world = m.world();
  f.ballR = t.ballRadius;
  f.footR = t.footRadius;
  f.goalH = m.goalHOf(side);
  f.wind = world.wind ?? 0;
  f.playTime = world.time ?? 0;
  const inMatch = !!st && st.phase !== 'lobby' && st.phase !== 'full_time';

  if (m.runs && side === m.side) {
    // This screen simulates the half.
    const a = m.live ? alpha : 1;
    f.balls = m.balls().map((b) => toDraw(b, a, side));
    f.ghosts = m.ghosts().map((b) => toDraw(b, a, side));
    // The opponent's balls show only while part of them overlaps this screen's edge.
    f.remotes = m.remotes().filter((r) => Math.abs(r.x - HALF_X) < t.ballRadius);
    f.incoming = m.incoming();
    f.keeper = m.keeperOn() ? { y: m.keeper.y, stunned: m.keeper.stun > 0 } : null;
    const charged = m.meter >= 1;
    if (ownFoot) {
      f.feet.push({ ...footNow(tracker), state: m.frozen ? 'frozen' : m.stunLeft > 0 ? 'stun' : null, charged });
    }
    if (m.mate && inMatch) {
      f.feet.push({ ...footNow(mateTracker), state: m.frozen ? 'frozen' : m.mateStun > 0 ? 'stun' : null, charged });
    }
  } else {
    // Drawn from what the half's runner reports.
    const v = inMatch ? m.viewOf(side) : null;
    if (v) {
      f.balls = v.balls.map((b) => ({ x: b.x, y: b.y, angle: b.angle, speed: Math.hypot(b.vx, b.vy), fire: b.fire }));
      f.keeper = v.keeper;
      const charged = v.meter >= 1;
      // A second player draws their own boot from their own mouse, so it never lags.
      v.feet.forEach((foot, i) => {
        if (!(ownFoot && i === 1)) f.feet.push({ ...foot, charged });
      });
    }
    if (ownFoot) {
      const mine = v?.feet[1]?.state ?? null;
      f.feet.push({ ...footNow(tracker), state: mine, charged: (v?.meter ?? 0) >= 1 });
    }
  }

  if (m.arcade && inMatch) {
    f.arena = world.arena ?? null;
    f.portalsOpen = m.portalsOpen();
    f.portalSecs = m.portalSecs();
    f.items = m.itemsNow().filter((i) => (side === 'A' ? i.x < HALF_X : i.x >= HALF_X));
  }
}

const footNow = (t: FootTracker) => ({ x: t.x, y: t.y, vx: t.vx, vy: t.vy });

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  time += dt;

  // A watcher has no side of their own; their main picture is the left half.
  const watching = mode === 'match' && !!match?.watching;
  // The whole pitch, twice as wide, but only while the game itself is on screen: menus stay full size.
  view.setWide(watching && ui.screen === null);
  const side: Side = (mode === 'match' && match?.side) || 'A';
  const playing = inPlay();

  if (hitstop > 0) hitstop -= dt;
  else if (mode === 'idle') runAttract(dt);
  else if (mode === 'match' || playing) simulate(dt);
  match?.tick();
  react();

  if (ui.screen === 'howto') howto.tick(dt);

  const alpha = acc / DT;
  const f = plainFrame(side, mode === 'practice', dt, time);
  f.ballR = tuning.ballRadius;
  f.footR = tuning.footRadius;
  let other: Frame | null = null;
  let led = IDLE_LED;
  let hudOn = false;
  let hud: ArcadeHud | null = null;

  if (mode === 'practice' && practice) {
    const s = practice.stats;
    f.balls = [toDraw(practice.ball, playing ? alpha : 1, side)];
    if (playing) f.feet.push({ ...footNow(tracker), state: null, charged: false });
    ui.practiceHud(
      `SHOT ${kmh(s.lastShot)} KM/H  BEST ${kmh(s.bestShot)}    JUGGLES ${s.juggle}  BEST ${s.bestJuggle}    WALL GOALS ${s.goals}`,
    );
    led = 'PRACTICE    SHOOT AT THE WALL AND SCORE ON THE REBOUND';
  } else {
    ui.practiceHud(null);
  }

  if (mode === 'match' && match && net) {
    const st = match.state;
    hudOn = !!st && st.phase !== 'lobby' && st.phase !== 'full_time';
    const names = { A: match.nameOf('A') || 'BLUE', B: match.nameOf('B') || 'ORANGE' };

    if (watching) {
      drawHalf(f, match, 'A', alpha, false);
      other = plainFrame('B', false, dt, time);
      drawHalf(other, match, 'B', alpha, false);
    } else {
      drawHalf(f, match, side, alpha, playing);
      // A second player keeps their half's runner told where their boot is.
      if (playing && !match.runs && match.side) match.sendFoot(tracker.x, tracker.y);
    }
    input.maxY = match.world().arena?.roof ?? ROOF_Y;

    if (match.arcade && hudOn) {
      hud = arcadeHud(match);
      const mod = match.modNow();
      if (match.arcade.frenzy) led = 'FINAL FRENZY    TWO BALLS    GOALS COUNT DOUBLE';
      else if (mod?.running) led = `${MODS[mod.kind].name}    ${MODS[mod.kind].text}`;
      else if (mod) led = `COMING UP: ${MODS[mod.kind].name}`;
      else if (match.code) led = `SPLIT-SCREEN FOOTBALL    ROOM ${match.code}`;
    } else if (match.code) {
      led = `SPLIT-SCREEN FOOTBALL    ROOM ${match.code}`;
    }

    ui.hud(
      hudOn && st
        ? {
            side: match.side,
            score: st.score,
            clockMs: match.clockMs(),
            golden: st.golden,
            names,
            series: st.series,
            seriesScore: st.seriesScore,
          }
        : null,
    );

    if (st?.phase === 'countdown') {
      const n = Math.max(1, Math.ceil(match.timerMs() / 1000));
      if (n !== lastCount) {
        lastCount = n;
        sfx.beep();
      }
      ui.count(String(n));
    } else {
      ui.count(null);
    }

    if (!net.connected && hudOn) {
      ui.wait('CONNECTION LOST', 'RECONNECTING...');
    } else if (st?.phase === 'paused') {
      ui.wait(
        st.pauseReason === 'disconnect' ? 'A PLAYER DISCONNECTED' : 'PAUSED',
        `WAITING FOR THEM... ${secs(match.timerMs())}S`,
      );
    } else {
      ui.wait(null);
    }

    const room = match.room;
    if (ui.screen === 'lobby') ui.lobby(room, match.you, net.connected, shareHost());
    if (ui.screen === 'bracket' && room?.bracket) {
      ui.bracket(room.bracket, match.you, match.isHost, match.bracketStartIn());
    }
    if (ui.screen === 'rules' && room) ui.rules(room.config, match.isHost);
    if (ui.screen === 'fulltime' && match.result && room) {
      // Whether the other side has asked for another game; null if they have gone.
      const rivals = match.side ? match.team(match.side === 'A' ? 'B' : 'A') : [];
      const theirs = rivals.length ? rivals.every((p) => p.ready) : null;
      ui.fullTime(
        match.result,
        match.side,
        room.config.series,
        !!match.me?.ready,
        theirs,
        names,
        news,
        !!room.bracket,
      );
    }

    const s = match.stats;
    debug.setInfo(
      `seat ${match.seat ?? 'watching'}   seq ${match.seq}   balls here ${match.balls().length}   phase ${st?.phase ?? '-'}\n` +
        `handoffs out ${s.out}  in ${s.in}\n` +
        `resent ${s.resent}  repeats ignored ${s.dup}  dropped ${s.dropped}\n` +
        `last transit ${s.transitMs} ms (same-machine clock)`,
    );
  } else {
    ui.hud(null);
    ui.count(null);
    ui.wait(null);
    if (mode === 'idle') f.balls = [toDraw(attract.ball, alpha, side)];
  }
  ui.arcadeHud(hud);
  ui.signal(hudOn && net ? net.rtt : undefined);

  const goalLed = time < ledUntil;
  for (const r of [renderer, rendererB]) {
    if (goalLed) r.setLed('GOAL!   GOAL!   GOAL!   GOAL!', '#ffffff');
    else r.setLed(led);
  }

  // The crowd gets louder as a ball nears a goal or flies fast.
  buzz = Math.max(0, buzz - dt * 0.4);
  let level = mode === 'idle' ? 0.15 : 0.3;
  const lead = f.balls[0] ?? other?.balls[0];
  if (lead && mode !== 'idle') {
    const fromGoal = Math.min(lead.x, WORLD_W - lead.x);
    level += Math.max(0, 1 - fromGoal / 18) * 0.35 + Math.min(1, lead.speed / tuning.maxShot) * 0.2;
  }
  sfx.crowd(Math.min(1, level + buzz));

  if (other) {
    const left = renderer.render(f);
    const right = rendererB.render(other);
    view.present(out, [left.buffer, right.buffer], left.sx, left.sy);
  } else {
    renderer.draw(out, view, f);
  }
}

// Wait for the pixel font so the stadium's LED strip is drawn with it.
void document.fonts
  .load('8px "Press Start 2P"')
  .catch(() => {})
  .then(() => {
    applySettings();
    ui.show('splash');
    requestAnimationFrame(frame);
  });
