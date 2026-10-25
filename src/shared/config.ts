import { MELD_TARGET, VERSUS_LINE_TARGET } from './constants.js';
import type { GameMode } from './types.js';

/**
 * Per-room rules. Everything here changes gameplay, so the host owns it and both clients
 * receive the same authoritative values through the lobby broadcast and every snapshot.
 */
export type MatchObjective = 'target' | 'endless' | 'sudden';
export type MeteorMode = 'off' | 'standard' | 'starfall';
export type ChaosLevel = 'off' | 'occasional' | 'frequent';

export interface MatchConfig {
  /** Together: `target` or `endless`. Duel: `target` or `sudden`. */
  objective: MatchObjective;
  /** Melds needed in Together or rows needed in a Duel; 0 means no target. */
  target: number;
  meldMeter: boolean;
  meteor: MeteorMode;
  chaos: ChaosLevel;
  /** Duel only: spend clear charge to disrupt the rival. */
  clash: boolean;
}

export const MELD_TARGET_MIN = 5;
export const MELD_TARGET_MAX = 100;
export const MELD_TARGET_PRESETS = [5, 10, 15, 20, 30, 40, 50, 75, 100];
export const VERSUS_TARGET_MIN = 3;
export const VERSUS_TARGET_MAX = 20;
export const VERSUS_TARGET_PRESETS = [3, 5, 8, 12, 15, 20];

/** Modes that offer the rules panel; other modes keep their designed shape. */
export function configurableMode(mode: GameMode): boolean {
  return mode === 'coop' || mode === 'versus';
}

export function defaultConfig(mode: GameMode): MatchConfig {
  return {
    objective: 'target',
    target: mode === 'versus' ? VERSUS_LINE_TARGET : MELD_TARGET,
    meldMeter: false,
    meteor: 'off',
    chaos: 'off',
    clash: false,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** Coerces anything that arrived over the wire into a legal rule set for the mode. */
export function normalizeConfig(mode: GameMode, input?: Partial<MatchConfig> | null): MatchConfig {
  const base = defaultConfig(mode);
  if (!input || typeof input !== 'object') return base;

  const together = mode === 'coop';
  const duel = mode === 'versus';
  const objective: MatchObjective = together
    ? input.objective === 'endless'
      ? 'endless'
      : 'target'
    : duel
      ? input.objective === 'sudden'
        ? 'sudden'
        : 'target'
      : 'target';

  const target = together
    ? clamp(Number(input.target ?? base.target), MELD_TARGET_MIN, MELD_TARGET_MAX)
    : duel
      ? clamp(Number(input.target ?? base.target), VERSUS_TARGET_MIN, VERSUS_TARGET_MAX)
      : base.target;

  const meteor: MeteorMode =
    input.meteor === 'standard' || input.meteor === 'starfall' ? input.meteor : 'off';
  const chaos: ChaosLevel =
    input.chaos === 'occasional' || input.chaos === 'frequent' ? input.chaos : 'off';

  return {
    objective,
    // An Endless or Sudden Death room has no numeric target; keep the value for the UI.
    target,
    meldMeter: Boolean(input.meldMeter) && (together || duel),
    meteor: together ? meteor : 'off',
    chaos: together ? chaos : 'off',
    clash: Boolean(input.clash) && duel,
  };
}
