import type { MatchConfig } from './config.js';

export type Phase = 'countdown' | 'playing' | 'won' | 'lost';

export type GameMode = 'solo' | 'coop' | 'versus' | 'relay' | 'rift' | 'endless' | 'architect';

/** Pace of gravity. Zen is a slower ramp, Normal is the designed pace, Hard starts quick. */
export type Difficulty = 'zen' | 'normal' | 'hard';

export const DIFFICULTIES: Difficulty[] = ['zen', 'normal', 'hard'];

export function isDifficulty(value: unknown): value is Difficulty {
  return value === 'zen' || value === 'normal' || value === 'hard';
}

/** Modes played alone in one tab. */
export const SOLO_MODES: GameMode[] = ['solo', 'endless', 'architect'];
/** Modes that need a room; the host selects the mode and the guest inherits it. */
export const ONLINE_MODES: GameMode[] = ['coop', 'versus', 'relay', 'rift'];

export function isSoloMode(mode: GameMode): boolean {
  return SOLO_MODES.includes(mode);
}

export function isOnlineMode(mode: GameMode): boolean {
  return ONLINE_MODES.includes(mode);
}

/** A locked cell remembers which player placed it (for Meld rows) and which piece kind (for colour). */
export interface Cell {
  /** Owning player slot. */
  p: 0 | 1;
  /** Piece kind index, used to pick the block colour. */
  k: number;
}

export interface Piece {
  k: number;
  r: number;
  x: number;
  y: number;
  /** Ticks since this piece last fell one row. */
  fallT: number;
  /** Ticks the piece has been resting. */
  lockT: number;
  /** Lock-delay resets used by this piece. */
  resets: number;
}

export type EventType =
  | 'clear'
  | 'meld'
  | 'ping'
  | 'lock'
  | 'win'
  | 'lose'
  | 'start'
  | 'meter'
  | 'meteor'
  | 'chaos'
  | 'chaosEnd'
  | 'attack';

/** Environmental hazard: a burning crystal cube falling on a telegraphed cell. */
export interface Meteor {
  col: number;
  row: number;
  /** Tick when it lands. */
  at: number;
  /** Starfall variant: brighter and clears a wider area. */
  star: boolean;
}

export type ChaosKind = 'lowGravity' | 'surge' | 'blackout' | 'colorSurge';

/** A timed chaos event. `start` is after the announcement window so players can prepare. */
export interface ChaosState {
  kind: ChaosKind;
  start: number;
  end: number;
}

export type AttackKind = 'obstruction' | 'surge' | 'shell';

/** A crystal shell plate that keeps a cell from clearing until it expires. */
export interface CellShell {
  /** Board index. */
  i: number;
  until: number;
}

/** Small state events used purely for feedback; the client renders and dedupes them. */
export interface GameEvent {
  id: number;
  tick: number;
  type: EventType;
  /** Player that caused the event. */
  p?: number;
  /** Rows (indices at clear time) for `clear` / `meld`. */
  rows?: number[];
  /** Row count or meld count, depending on the event. */
  n?: number;
  col?: number;
  row?: number;
  star?: boolean;
  /** Combo depth for a clear. */
  combo?: number;
  /** Chaos or Clash flavour, depending on the event type. */
  kind?: ChaosKind | AttackKind;
}

export interface PlayerRuntime {
  piece: Piece | null;
  /** Upcoming piece kinds, at least one entry while the match runs. */
  next: number[];
  cells: number;
  /** Rows this player had cells in when they cleared. */
  rows: number;
  /** Co-op objective credit earned by this player. */
  melds: number;
  /** Rows this player finished (the versus score); rows with their cells are `rows`. */
  clears: number;
  lastPingTick: number;
}

export interface GameState {
  mode: GameMode;
  difficulty: Difficulty;
  tick: number;
  /** Ticks spent in the playing phase; drives gravity ramping. */
  playTicks: number;
  phase: Phase;
  phaseTick: number;
  board: (Cell | null)[];
  players: PlayerRuntime[];
  /** xorshift32 state per player, kept in the state so replays are deterministic. */
  rng: number[];
  bags: number[][];
  score: number;
  lines: number;
  melds: number;
  objective: number;
  /** Winner slot for a versus match; null when the objective is shared. */
  winner: number | null;
  /** Active slot in Relay, where only one piece falls at a time. */
  turn: number;
  /** Host-owned room rules; both clients simulate with the same copy. */
  config: MatchConfig;
  /** Meld Meter charge in ticks, one per player. */
  meter: number[];
  /** Clash Attack charge in points, one per player. */
  attack: number[];
  attackCooldown: number[];
  /** Tick until a Gravity Surge speeds this player's fall. */
  surgeUntil: number[];
  shells: CellShell[];
  meteors: Meteor[];
  nextMeteorTick: number;
  chaos: ChaosState | null;
  nextChaosTick: number;
  lastChaos: ChaosKind | null;
  /** Consecutive clear depth and the tick the chain window closes. */
  combo: number;
  comboUntil: number;
  events: GameEvent[];
  eventSeq: number;
}

export type Action =
  | { t: 'left' }
  | { t: 'right' }
  | { t: 'rot'; d: 1 | -1 }
  | { t: 'soft' }
  | { t: 'hard' }
  | { t: 'ping'; col?: number }
  | { t: 'meter' }
  | { t: 'clash'; kind: AttackKind };

export interface PlayerMeta {
  name: string;
  palette: string;
}

export interface Snapshot {
  v: 1;
  difficulty: Difficulty;
  tick: number;
  playTicks: number;
  phase: Phase;
  phaseTick: number;
  board: string;
  score: number;
  lines: number;
  melds: number;
  objective: number;
  players: {
    piece: [number, number, number, number] | null;
    next: number[];
    cells: number;
    rows: number;
    melds: number;
    clears: number;
    /** Last action sequence number processed for this player. */
    seq: number;
  }[];
  events: GameEvent[];
  winner?: number | null;
  turn?: number;
  paused?: boolean;
  pauseMs?: number;
  config?: MatchConfig;
  meter?: number[];
  attack?: number[];
  attackCooldown?: number[];
  surgeUntil?: number[];
  shells?: CellShell[];
  meteors?: Meteor[];
  nextMeteorTick?: number;
  chaos?: ChaosState | null;
  nextChaosTick?: number;
  lastChaos?: ChaosKind | null;
  combo?: number;
  comboUntil?: number;
}
