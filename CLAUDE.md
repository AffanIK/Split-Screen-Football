# CLAUDE.md

Split-Screen Football: a two-player browser game. Each player sees one half of a side-view pitch; the ball crosses between screens through a small WebSocket server. The cursor is a foot, with no clicks during play.

Built so far: solo practice; private rooms for up to eight people with seats, watchers, 1 v 1 and 2 v 2, and single-elimination tournaments; full match rules (score, clock, golden goal, stalling, pause and rejoin, best-of-3, rematch) that the host can customise; a goalkeeper bot; eight arenas; power-ups, hazards and modifiers; names, emotes and device-local records; a pixel-art night stadium with a crowd; and the full screen flow from splash to full time. Not built yet: deployment to a public server, spin on the ball, finished (non-synthesised) audio.

The host sets the rules in the lobby (`src/shared/config.ts`). The **Arcade** preset (default) turns on growing goals, the super meter, power-ups, hazards, modifiers, a goalkeeper bot, a random arena and the two-ball final frenzy; **Classic** turns all of it off; any single change makes it **Custom**.

## Stack

TypeScript everywhere. Client: Vite + raw Canvas 2D for the game, DOM for menus and scoreboard, Web Audio for synthesised sound. Server: Node + `ws`. Tests: Vitest. No game framework, no physics engine, no image or sound files, by design. The only asset is the bundled pixel font (`@fontsource/press-start-2p`).

## Layout

- `src/shared/` — simulation, rules and protocol used by client, server, tests and bots. No DOM or Node imports allowed here.
  - `constants.ts` world size and the live-editable `tuning` object; `physics.ts` ball step; `foot.ts` cursor-foot contact; `handoff.ts` ownership rule; `rules.ts` match rules and room codes; `protocol.ts` message types.
  - `effects.ts` every Arcade number (`ARCADE`), the power-up, hazard and modifier tables, and `effectiveTuning()`; `arena.ts` the eight arenas, in side A's frame; `keeper.ts` the goalkeeper bot; `config.ts` match rules, presets, names and emotes; `bracket.ts` the tournament draw.
- `src/server/` — `relay.ts` ownership of one ball (owner, sequence number, ACK and resend, validation), one instance per ball; `room.ts` members, seats, lobby, match state machine and tournament flow; `arcade.ts` the Arcade director (what appears and when); `rooms.ts` rooms by join code; `index.ts` WebSocket wiring.
- `src/client/` — `main.ts` loop and app flow; `match.ts` client state machine (DOM-free, reused by the soak bots); `records.ts` device-local history; `practice.ts`; `input.ts`; `audio.ts`; `net.ts`; `settings.ts`; `debug.ts`; `view.ts`.
  - `gfx/` — `pixel.ts` buffer and helpers; `sprites.ts` sprites generated in code; `stadium.ts` background, crowd, LED strip; `fx.ts` particles; `renderer.ts` one frame.
  - `ui/` — `ui.ts` screens, scoreboard, callouts; `howto.ts` move demos; `style.css`.
- `tests/` unit tests; `scripts/soak.ts` the handoff gate.

## Rules of the design

- World units are metres, y up, ground at y = 0, solid roof at `ROOF_Y`. Side A sees x 0–50, side B 50–100. Side B is simulated as the mirror of side A.
- Physics runs at a fixed 120 Hz; rendering interpolates.
- Exactly one screen owns the ball. Only the server decides the owner, the phase, the score and the clock. Every handoff carries a sequence number; both legs are resent until confirmed. Killing a ball (goal, stall, full time) bumps the sequence number so stale messages are ignored.
- A room has up to eight members. Each has a **seat** (`A1`, `B1`, and `A2`, `B2` in 2 v 2) or watches. **Seat 1 on a side runs that half**: it simulates the balls there and is the only one the server takes ball messages from. A second player sends their boot position up (`foot`); the runner simulates both boots and streams its half back (`view`, about 30 a second), which is also what watchers are shown. If a runner drops in 2 v 2, their teammate is moved to seat 1 and the side's balls are re-dropped.
- Watchers see both halves side by side from the two `view` streams, so their picture is approximate and slightly late; nothing on the server simulates the ball.
- A tournament seats two members at a time and makes the rest watch; `room.ts` reports each result into the bracket and seats the next tie.
- A match can have two balls (ids 0 and 1), each with its own relay and sequence. Any goal kills both.
- Arcade timing runs on **play time**, which advances only in the `playing` phase. The server sends the whole Arcade state inside every `match_state` with times as "from now"; clients count them down only while playing. Nothing in Arcade reads the global `tuning` mid-match: each client simulates with `MatchClient.tuningNow()` and `world()`.
- Power-ups go to the ball's last kicker (`ball.by`), which travels with the ball in the handoff, as do `fire` and `ghost`.
- A goal is always conceded by the screen that owns the ball, so the point goes to the other side and the conceder kicks off.
- Ball speed is capped at `tuning.maxShot` in flight as well as on a kick; the server rejects anything faster.
- The game draws into a 640×360 buffer (12.8 px per metre) scaled up by a whole number with no smoothing. The DOM layer sits exactly over it and sizes everything in `em`, where 1em = 8 buffer pixels, so interface and game share one pixel size.

## Commands

- `npm run dev` — game at http://localhost:5190 plus the game server on ws://localhost:8787
- `npm test` — unit tests
- `npm run soak` — 500 handoffs across two balls in a 2 v 2 room with a watcher, 20% message loss and jitter (about 35 s); must print PASS
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — production client bundle
- `npm run worker:dev` — the game server in Cloudflare's local runtime on port 8787; `SOAK_URL=ws://127.0.0.1:8787 npm run soak` tests against it
- `npm run worker:deploy` — deploy the game server to Cloudflare (needs `npx wrangler login`)

## Deployment

- **Pages:** Vercel (`vercel.json`), built with `VITE_GAME_SERVER` set to the game server's `wss://` address. Without it the pages look for a server on the same host at port 8787.
- **Game server:** Cloudflare Workers with one Durable Object per room (`src/worker/index.ts`, `wrangler.toml`). Creating a match connects to `/ws/new`; joining or rejoining connects to `/ws/room/CODE`. The connection logic is shared with the Node server (`src/server/connection.ts`), which ignores the path. Render and Railway were tried first and both asked for a card; their config files (`render.yaml`, `railway.json`) remain in case a card is added later.
- The worker has its own type-check (`tsconfig.worker.json`); `npm run typecheck` runs both.

In the game: Esc opens the menu, M mutes, 1 to 6 send emotes, F toggles full screen, ` opens the developer tuning panel (with network delay and loss sliders in a match). A share link is `/?room=CODE`; add `&watch=1` to join as a watcher. In development the current match is on the browser console as `ssf.match` (used by scripted checks to place the ball or fill the meter).

## Skills (installed in `.claude/skills/`)

- `2d-games` — sprites, tilemaps, physics, camera
- `game-design` — GDD structure, balancing, player psychology, progression
- `web-games` — browser frameworks, WebGPU, optimization, PWA
- `game-art` — style selection, asset pipeline, animation workflow
- `game-audio` — sound design, music integration, adaptive audio

## Environment

- Windows 11, PowerShell. Node.js is a portable install at `%LOCALAPPDATA%\nodejs-portable` (on the user PATH).
- If `node` is not found in a shell that predates the PATH change, prefix commands with `$env:Path = "$env:LOCALAPPDATA\nodejs-portable;$env:Path";`.
- Same-network play: other devices open `http://<this PC's network address>:5190` (printed by `npm run dev`). Windows Firewall must allow inbound TCP 5190 and 8787; this PC is on a domain network and the user is not an administrator, so that may need IT.
- Ports 5173 and 5174 are used by other apps on this machine, so Vite is pinned to 5190.
