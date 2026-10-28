import type { Difficulty } from './types.js';

/** Shared tuning values. The engine has no clock of its own: every duration is in ticks. */

export const COLS = 10;
export const ROWS = 20;

/** Authoritative simulation step (50 ms → 20 Hz). */
export const TICK_MS = 50;

/** How long a resting piece may sit before it locks. */
export const LOCK_DELAY_TICKS = 8; // 400 ms
/** Maximum number of move/rotate lock-delay resets. */
export const MAX_LOCK_RESETS = 12;

export const COUNTDOWN_TICKS = 60; // 3 s

/** Melds required to win a co-op match (see DESIGN_DECISIONS.md). */
export const MELD_TARGET = 5;
/** Rows required to win a solo practice run. */
export const SOLO_LINE_TARGET = 12;
/** Rows a player must finish to win a Duel. */
export const VERSUS_LINE_TARGET = 8;
/** Rows to clear in the Architect puzzle. */
export const ARCHITECT_LINE_TARGET = 10;
/** Rift survival: three 60-second waves of rising pressure. */
export const RIFT_WAVES = 3;
export const RIFT_WAVE_TICKS = 1200;

/** Spawn columns per player so the two pieces never spawn inside each other. */
export const SPAWN_X = [1, 5];
export const MAX_PLAYERS = 2;

export const PING_COOLDOWN_TICKS = 40;
export const PING_LIFE_TICKS = 60;

export const BASE_GRAVITY_MS = 850;
export const MIN_GRAVITY_MS = 280;
export const GRAVITY_RAMP_MS_PER_SEC = 5;

/**
 * Gravity per difficulty. Normal eases over roughly two minutes instead of collapsing into the
 * fast pace at the halfway point; Zen slows both the fall and the ramp so a first match never
 * turns frantic, and Hard opens at speed instead of building toward it.
 */
export const DIFFICULTY_PROFILES: Record<
  Difficulty,
  { baseMs: number; minMs: number; rampMsPerSec: number }
> = {
  zen: { baseMs: 1200, minMs: 380, rampMsPerSec: 6 },
  normal: { baseMs: BASE_GRAVITY_MS, minMs: MIN_GRAVITY_MS, rampMsPerSec: GRAVITY_RAMP_MS_PER_SEC },
  hard: { baseMs: 320, minMs: 110, rampMsPerSec: 18 },
};

/** Reconnect grace window before a co-op match is abandoned. */
export const DISCONNECT_GRACE_MS = 30_000;

/** A clear inside this window continues the combo chain. */
export const COMBO_WINDOW_TICKS = 100; // 5 s
/** Hardest the ramp can get in Sudden Death. */
export const SUDDEN_DEATH_FLOOR = 0.5;

/** Meld Meter fills at these paces so an ability never arrives before a match is warm. */
export const METER_CHARGE_SECONDS: Record<Difficulty, number> = { zen: 30, normal: 60, hard: 120 };

/** Meteor Storm: telegraph length and the 20-35 s cadence. */
export const METEOR_LEAD_TICKS = 50; // 2.5 s
export const METEOR_MIN_TICKS = 400;
export const METEOR_MAX_TICKS = 700;
/** Starfall share of meteors when the variant is enabled (percent). */
export const STARFALL_CHANCE = 18;

/** Chaos events: announcement lead, duration, and cadence per level. */
export const CHAOS_ANNOUNCE_TICKS = 60; // 3 s
export const CHAOS_DURATION_TICKS = {
  lowGravity: 300,
  surge: 240,
  blackout: 200,
  colorSurge: 240,
} as const;
export const CHAOS_INTERVAL_TICKS = { occasional: [1200, 2000], frequent: [500, 900] } as const;

/** Clash Attack: a charge costs four cleared rows, banks two charges, and cools down for 6 s. */
export const ATTACK_COST = 4;
export const ATTACK_MAX_POINTS = ATTACK_COST * 2;
export const ATTACK_COOLDOWN_TICKS = 120;
export const SURGE_TICKS = 200; // 10 s on the rival
export const SHELL_TICKS = 160; // 8 s
/** How many blocked cells a Crystal Shell may cover. */
export const SHELL_MAX_CELLS = 3;
/** A Crystal Obstruction drops at most this many cells. */
export const OBSTRUCTION_CELLS = 2;

/** Extra points for finishing a row your partner started. */
export const MELD_BONUS = 200;

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;
// v2 adds the host-selected difficulty to welcome, lobby and snapshot messages.
// v3 adds the host-owned match rules to welcome and lobby messages.
export const PROTOCOL_VERSION = 3;
