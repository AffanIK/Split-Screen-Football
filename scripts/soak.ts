// Handoff gate: many handoffs in a row over a lossy, jittery link with no ball
// lost or duplicated, with two balls in play at once. Headless bots fill a 2 v 2
// room (two per side, plus one watching), ready up, and then run the real client
// state machine and shared physics against the real server.
import WebSocket from 'ws';
import { MatchClient, type Intent } from '../src/client/match';
import { startServer } from '../src/server/index';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol';

const PORT = 8790;
const TARGET = 500;
const LOSS = 0.2;
const MAX_DELAY_MS = 30;
const RESEND_MS = 80;
const TIMEOUT_MS = 180_000;
// The streams to watchers and teammates are also lossy; nothing depends on any one of them.
const LOSSY = new Set(['handoff', 'handoff_ack', 'handoff_ok', 'ball_preview', 'view', 'foot']);
const NEVER = 3_600_000;

/**
 * SOAK_URL points the run at a server that is already running (for example
 * 
pm run worker:dev, Cloudflare's local runtime) instead of starting one. That
 * server uses its normal rules and resend timing, and its rooms cannot be inspected,
 * so the run checks only what the clients can see and keeps to one ball.
 */
const REMOTE = process.env.SOAK_URL;
const server = REMOTE
  ? null
  : startServer(PORT, {
      resendMs: RESEND_MS,
      // No clock, no stalling whistle: this run is only about the handoff.
      rules: { matchMs: NEVER, stallMs: NEVER, countdownMs: 100 },
    });
const BASE = REMOTE ?? `ws://localhost:${PORT}`;
let doubles = 0;
let stopped = false;
let secondBall = false;
let teamSet = false;

/**
 * Drops a share of ball messages and delays the rest by a random amount, so
 * they also arrive out of order. Room and match messages are left alone: a
 * WebSocket delivers in order, and the protocol only promises to survive ball-message faults.
 */
function impair(type: string, deliver: () => void): void {
  if (!LOSSY.has(type)) return deliver();
  if (Math.random() < LOSS) return;
  setTimeout(deliver, Math.random() * MAX_DELAY_MS);
}

function makeBot(intent: Intent) {
  const ws = new WebSocket(intent.type === 'join' ? `${BASE}/ws/room/${intent.code}` : `${BASE}/ws/new`);
  const client = new MatchClient(
    (m: ClientMsg) =>
      impair(m.type, () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
      }),
    intent,
    () => performance.now(),
    RESEND_MS,
  );
  ws.on('open', () => client.open());
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as ServerMsg;
    impair(m.type, () => {
      client.onMessage(m);
      check();
    });
  });
  /** Send something the client class has no method for. */
  const raw = (m: ClientMsg) => ws.send(JSON.stringify(m));
  /** When each ball this bot holds will be kicked back. */
  return { ws, client, raw, kickAt: new Map<number, number>(), readied: false, seated: false };
}

type Bot = ReturnType<typeof makeBot>;
const bots: Bot[] = [makeBot({ type: 'create' })];

const room = () => (bots[0].client.code && server ? server.rooms.get(bots[0].client.code)?.room : undefined);
/** How many copies of one ball exist across both clients. */
const copies = (id: number) => bots.filter((b) => b.client.balls().some((ball) => ball.id === id)).length;

function check(): void {
  if (copies(0) > 1 || copies(1) > 1) doubles++;
}

const started = performance.now();
const loop = setInterval(() => {
  const now = performance.now();
  // The others join once the first has its room code: three more players and a watcher.
  const code = bots[0].client.code;
  if (bots.length === 1 && code) {
    for (let i = 0; i < 3; i++) bots.push(makeBot({ type: 'join', code }));
    bots.push(makeBot({ type: 'join', code, watch: true }));
  }
  // The host makes it 2 v 2, and the two players left standing take the second seats.
  const lobby = bots[0].client.room;
  if (lobby && lobby.players.length === 5 && lobby.team === 1 && !teamSet) {
    teamSet = true;
    bots[0].raw({ type: 'set_team', size: 2 });
  }
  if (lobby?.team === 2) {
    bots.forEach((bot, i) => {
      const c = bot.client;
      if (!bot.seated && i >= 2 && i <= 3 && c.me && !c.seat) {
        bot.seated = true;
        c.setSeat(i === 2 ? 'A2' : 'B2');
      }
    });
  }

  for (const bot of bots) {
    const c = bot.client;
    const full = (c.room?.players ?? []).filter((p) => p.seat).length === 4;
    if (!bot.readied && full && c.seat) {
      bot.readied = true;
      // Plain rules: nothing but the balls should be happening.
      if (c.isHost) c.setConfig({ preset: 'classic' });
      c.setReady(true);
    }
    // Runners describe their half to the watcher and their teammate, as in a real match.
    c.myFoot = { x: 25, y: 5, vx: 0, vy: 0 };
    if (c.seat && !c.runs) c.sendFoot(25, 5);
    c.tick();
    if (stopped) continue;
    const held = c.balls();
    for (const id of [...bot.kickAt.keys()]) if (!held.some((b) => b.id === id)) bot.kickAt.delete(id);
    for (const ball of held) {
      if (!bot.kickAt.has(ball.id)) bot.kickAt.set(ball.id, now + Math.random() * 20);
      if (now >= bot.kickAt.get(ball.id)!) {
        const dir = c.side === 'A' ? 1 : -1;
        // Stays under the shot cap, as a real foot contact always does.
        ball.vx = dir * (12 + Math.random() * 20);
        ball.vy = (Math.random() - 0.5) * 16;
      }
    }
    for (let i = 0; i < 8 && c.balls().length; i++) c.step(null, []);
  }
  check();

  // Once play is under way, put a second ball on the pitch.
  const r = room();
  if (!secondBall && r?.phase === 'playing') {
    secondBall = true;
    r.spawnExtraBall('B');
  }

  const handoffs = bots.reduce((n, b) => n + b.client.stats.out, 0);
  if (!stopped && handoffs >= TARGET) {
    stopped = true;
    // Let resends and late messages settle before the final count.
    setTimeout(finish, 1500);
  } else if (now - started > TIMEOUT_MS) {
    finish('timed out: a ball was probably lost');
  }
}, 2);

function finish(problem?: string): void {
  clearInterval(loop);
  const r = room();
  const out = bots.reduce((n, b) => n + b.client.stats.out, 0);
  const received = bots.reduce((n, b) => n + b.client.stats.in, 0);

  const failures: string[] = [];
  if (problem) failures.push(problem);
  if (!r && !REMOTE) failures.push('the room was never created');
  if (REMOTE && copies(0) !== 1) failures.push(`ball 0: ${copies(0)} copies at the end, expected exactly 1`);
  if (doubles > 0) failures.push(`two copies of one ball existed ${doubles} time(s)`);
  for (const relay of r?.relays ?? []) {
    const n = copies(relay.id);
    if (n !== 1) failures.push(`ball ${relay.id}: ${n} copies at the end, expected exactly 1`);
    const owner = bots.find((b) => b.client.runs && b.client.side === relay.owner)?.client;
    if (!owner?.balls().some((b) => b.id === relay.id)) {
      failures.push(`ball ${relay.id}: server says ${relay.owner} owns it but that client does not have it`);
    }
    if (relay.stats.rejected > 0) failures.push(`ball ${relay.id}: server rejected ${relay.stats.rejected} handoff(s)`);
  }
  if (out !== received) failures.push(`clients sent ${out} handoffs but received ${received}`);
  if (r && (r.score.A || r.score.B)) failures.push('a goal was scored: the bots should never let a ball in');
  const idle = bots.filter((b) => !b.client.runs);
  if (idle.some((b) => b.client.balls().length)) failures.push('a second player or watcher was holding a ball');
  const watcher = bots[4]?.client;
  if (!watcher?.viewOf('A') && !watcher?.viewOf('B')) failures.push('the watcher was not being shown the match');

  const sum = (f: (b: Bot) => number) => bots.reduce((n, b) => n + f(b), 0);
  console.log(`balls in play               : ${r?.relays.filter((x) => x.alive).length ?? 0}`);
  console.log(`handoffs sent / received    : ${out} / ${received}`);
  console.log(`server resends              : ${r?.relays.reduce((n, x) => n + x.stats.resends, 0) ?? '-'}`);
  console.log(`client resends              : ${sum((b) => b.client.stats.resent)}`);
  console.log(`repeats ignored by clients  : ${sum((b) => b.client.stats.dup)}`);
  console.log(`conditions                  : ${LOSS * 100}% ball-message loss, 0-${MAX_DELAY_MS} ms jitter`);
  console.log(`time                        : ${((performance.now() - started) / 1000).toFixed(1)} s`);
  console.log(failures.length ? `FAIL\n - ${failures.join('\n - ')}` : 'PASS: no ball lost or duplicated');

  for (const bot of bots) bot.ws.terminate();
  server?.close();
  process.exit(failures.length ? 1 : 0);
}
