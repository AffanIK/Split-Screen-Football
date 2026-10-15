import type { ArenaKind } from './arena';
import type { Bracket } from './bracket';
import type { Config, KeeperLevel } from './config';
import type { ItemKind, ModKind, PowerKind } from './effects';
import type { Side } from './types';

export type Phase = 'lobby' | 'countdown' | 'playing' | 'goal' | 'paused' | 'full_time';
export type Series = 1 | 3;
/** A member's id within their room. */
export type Slot = number;
/** A place on the pitch: side A or B, first or second player. Seat 1 runs that half's simulation. */
export type Seat = 'A1' | 'A2' | 'B1' | 'B2';
export type TeamSize = 1 | 2;
export type Format = 'match' | 'tournament';
/** A room holds up to this many people, players and watchers together. */
export const ROOM_MAX = 8;

export interface HandoffMsg {
  type: 'handoff';
  /** Which ball; 0 when left out. */
  ball?: number;
  /** Goes up by one at every handoff of this ball. */
  seq: number;
  y: number;
  vx: number;
  vy: number;
  /** Sender's clock, for the transit readout in the debug overlay. */
  t: number;
  /** Last kicker, and the states that travel with the ball. */
  by?: Side | null;
  fire?: boolean;
  ghost?: boolean;
}

export interface PreviewMsg {
  type: 'ball_preview';
  ball?: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** A boot as others see it. */
export interface FootView {
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: 'stun' | 'frozen' | null;
}

/** One half of the pitch as its runner sees it. */
export interface ViewMsg {
  type: 'view';
  balls: { id: number; x: number; y: number; vx: number; vy: number; angle: number; fire: boolean }[];
  /** The runner's boot, then their teammate's in 2 v 2. */
  feet: FootView[];
  keeper: { y: number; stunned: boolean } | null;
  /** The team's super meter and whether a ghost shot is waiting. */
  meter: number;
  ghost: boolean;
}

export interface PlayerInfo {
  id: Slot;
  /** Null for someone watching. */
  seat: Seat | null;
  side: Side | null;
  ready: boolean;
  connected: boolean;
  name: string;
  /** Current win streak, as reported by the player's own device. */
  streak: number;
  /** Joined to watch only: never drawn into a tournament. */
  watch: boolean;
}

/** A tournament in progress. */
export interface BracketState {
  rounds: Bracket;
  /** The tie being played or about to be, as [round, index]. */
  current: [number, number] | null;
  champion: Slot | null;
  /** Names by id, kept so that someone who has left still shows in the bracket. */
  names: Record<number, string>;
  /** Time until the next tie starts by itself. */
  startInMs: number | null;
}

export interface RoomStateMsg {
  type: 'room_state';
  code: string;
  /** Everyone in the room, players and watchers. */
  players: PlayerInfo[];
  /** Who sets the rules: the creator, or whoever has been there longest. */
  host: Slot;
  config: Config;
  team: TeamSize;
  format: Format;
  bracket: BracketState | null;
}

/** A power-up or target on the pitch. */
export interface ItemState {
  id: number;
  /** Whose half it is on. */
  half: Side;
  kind: ItemKind;
  /** Distance from that half's own goal line, and height, in metres. */
  lx: number;
  y: number;
  /** Time until it can be collected or takes effect; 0 once live. */
  liveInMs: number;
  /** Time until it disappears. */
  leftMs: number;
}

/** A power-up acting on someone. */
export interface EffectState {
  kind: PowerKind;
  /** Whose boot or goal it is acting on. */
  side: Side;
  /** Who collected it. */
  by: Side;
  leftMs: number;
  totalMs: number;
}

/**
 * Everything Arcade mode adds, as of the moment of sending. All times are in
 * ms of play: clients count them down only while the phase is `playing`.
 */
export interface ArcadeState {
  /** Play time so far; moving arena objects are placed by it. */
  playMs: number;
  arena: ArenaKind;
  keeper: KeeperLevel;
  goalH: number;
  /** Time until the goals next grow; null once they are at full height. */
  growInMs: number | null;
  /** The modifier that is announced or running. startsInMs is 0 once it runs. */
  mod: { kind: ModKind; startsInMs: number; leftMs: number } | null;
  /** Time until the next modifier is announced; null when there are no more. */
  nextModInMs: number | null;
  frenzy: boolean;
  frenzyInMs: number | null;
  /** inMs is the time until the rings change state. Null when the arena has none. */
  portals: { open: boolean; inMs: number } | null;
  items: ItemState[];
  effects: EffectState[];
}

export interface MatchStateMsg {
  type: 'match_state';
  phase: Phase;
  score: Record<Side, number>;
  /** Clock at the moment of sending; clients count down locally while playing. */
  remainingMs: number;
  golden: boolean;
  /** Game number within the series, from 1. */
  game: number;
  series: Series;
  seriesScore: Record<Side, number>;
  kickoff: Side;
  /** Length of the current countdown, or time left before a forfeit while paused. */
  timerMs: number;
  pauseReason: 'disconnect' | 'away' | null;
  /** Null in Classic mode. */
  arcade?: ArcadeState | null;
}

export interface PlayerStats {
  goals: number;
  shots: number;
  /** m/s */
  fastest: number;
  saves: number;
  /** 0..100 */
  possession: number;
  juggle: number;
  /** Saves made by this player's goalkeeper bot. */
  keeper: number;
}

export interface FullTimeMsg {
  type: 'full_time';
  winner: Side;
  forfeit: boolean;
  score: Record<Side, number>;
  seriesScore: Record<Side, number>;
  seriesOver: boolean;
  stats: Record<Side, PlayerStats>;
}

export type EventMsg =
  | { type: 'event'; kind: 'goal'; side: Side; speed: number; screamer: boolean; points: number }
  | { type: 'event'; kind: 'save' | 'bar' | 'stall' | 'match_point' | 'fire' | 'stun' | 'keeper'; side: Side }
  | { type: 'event'; kind: 'golden' | 'last_minute' | 'frenzy' | 'frenzy_soon' }
  /** `side` collected it. */
  | { type: 'event'; kind: 'pickup'; side: Side; item: ItemKind }
  | { type: 'event'; kind: 'mod_soon' | 'mod'; mod: ModKind }
  | { type: 'event'; kind: 'grow'; goalH: number };

export type ClientMsg =
  | { type: 'create_room'; name?: string; streak?: number }
  | { type: 'join_room'; code: string; token?: string; name?: string; streak?: number; watch?: boolean }
  /** Take a seat, or null to watch. Taking an occupied seat on the other side swaps the two players. */
  | { type: 'set_seat'; seat: Seat | null }
  | { type: 'set_team'; size: TeamSize }
  | { type: 'set_format'; format: Format }
  | { type: 'start_tournament' }
  | { type: 'end_tournament' }
  /** The second player on a side reports where their boot is. */
  | { type: 'foot'; x: number; y: number }
  /** The player running a half reports what is on it, for watchers and their teammate. */
  | ViewMsg
  | { type: 'set_side'; side: Side }
  /** The creator changes the match rules. */
  | { type: 'set_config'; patch: Partial<Config> }
  /** One of the canned reactions, by index. */
  | { type: 'emote'; id: number }
  | { type: 'ready'; ready: boolean }
  | { type: 'leave' }
  /** The tab was hidden or shown again. */
  | { type: 'away'; away: boolean }
  /** A ball this client owns crossed its own goal line. speed is how fast the shot arrived. */
  | { type: 'goal'; ball?: number; seq: number; speed: number; clean: boolean }
  | { type: 'stat'; game: number; shots: number; fastest: number; saves: number; juggle: number; keeper?: number }
  | { type: 'callout'; kind: 'save' | 'bar' | 'fire' | 'stun' | 'keeper' }
  /** A ball on this client's half touched an item. `by` is the ball's last kicker. */
  | { type: 'pickup'; id: number; by: Side }
  /** Super meter level 0..1 and whether a ghost shot is waiting, for the opponent's display. */
  | { type: 'meter'; v: number; ghost: boolean }
  | HandoffMsg
  | { type: 'handoff_ack'; ball?: number; seq: number }
  | PreviewMsg
  | { type: 'ping'; t: number };

export type ServerMsg =
  /** `lan` is the host computer's address on the local network, for share links. */
  | { type: 'joined'; code: string; token: string; you: Slot; lan?: string }
  | { type: 'error'; reason: 'not_found' | 'full' }
  | RoomStateMsg
  | MatchStateMsg
  | FullTimeMsg
  | EventMsg
  /** Tells the owner to drop a fresh ball near the halfway line. */
  | { type: 'spawn'; ball?: number; seq: number }
  /** The referee has taken this ball away from this client. */
  | { type: 'take_ball'; ball?: number }
  | HandoffMsg
  /** Server accepted the sender's handoff; the sender can stop resending. */
  | { type: 'handoff_ok'; ball?: number; seq: number }
  /** The sender claimed a ball it does not own. */
  | { type: 'drop_ball'; ball?: number; seq: number }
  | PreviewMsg
  /** The opponent's super meter. */
  | { type: 'meter'; side: Side; v: number; ghost: boolean }
  | { type: 'emote'; side: Side | null; name: string; id: number }
  | { type: 'foot'; x: number; y: number }
  | (ViewMsg & { side: Side })
  | { type: 'pong'; t: number };
