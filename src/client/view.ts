import type {
  Cell,
  CellShell,
  ChaosKind,
  ChaosState,
  Difficulty,
  GameEvent,
  GameMode,
  Meteor,
  Phase,
  Piece,
} from '../shared/types.js';
import type { MatchConfig } from '../shared/config.js';
import { RIFT_WAVE_TICKS } from '../shared/constants.js';

export interface ViewPlayer {
  name: string;
  paletteId: string;
  connected: boolean;
}

export interface ViewState {
  mode: GameMode;
  difficulty: Difficulty;
  phase: Phase;
  countdown: number;
  board: (Cell | null)[];
  pieces: (Piece | null)[];
  next: number[][];
  cells: number[];
  rows: number[];
  clears: number[];
  melds: number;
  objective: number;
  score: number;
  lines: number;
  winner: number | null;
  turn: number;
  /** Rift wave number, 1-based; 0 for other modes. */
  wave: number;
  players: ViewPlayer[];
  events: GameEvent[];
  localPlayer: number;
  paused: boolean;
  pauseMs: number;
  /** Host-owned room rules, identical on both clients. */
  config: MatchConfig;
  /** Meld Meter charge, 0..1 per player. */
  meter: number[];
  meterReady: boolean[];
  /** Clash Attack points and their cost, per player. */
  attack: number[];
  attackCost: number;
  attackCooldown: number[];
  meteors: Meteor[];
  chaos: ChaosState | null;
  /** True once the announced chaos effect is actually running. */
  chaosActive: boolean;
  /** Seconds until the announced chaos effect starts / until the running one ends. */
  chaosIn: number;
  chaosLeft: number;
  shells: CellShell[];
  combo: number;
}


export function difficultyKey(difficulty: Difficulty): 'diff.zen' | 'diff.normal' | 'diff.hard' {
  return difficulty === 'zen' ? 'diff.zen' : difficulty === 'hard' ? 'diff.hard' : 'diff.normal';
}

export function chaosKey(kind: ChaosKind): 'chaos.lowGravity' | 'chaos.surge' | 'chaos.blackout' | 'chaos.colorSurge' {
  if (kind === 'lowGravity') return 'chaos.lowGravity';
  if (kind === 'surge') return 'chaos.surge';
  if (kind === 'blackout') return 'chaos.blackout';
  return 'chaos.colorSurge';
}

export function riftWave(mode: GameMode, playTicks: number): number {
  if (mode !== 'rift') return 0;
  return Math.min(3, Math.floor(playTicks / RIFT_WAVE_TICKS) + 1);
}

export function countdownSeconds(phase: Phase, phaseTick: number, countdownTicks: number): number {
  if (phase !== 'countdown') return 0;
  return Math.max(0, Math.ceil((countdownTicks - phaseTick) / 20));
}
