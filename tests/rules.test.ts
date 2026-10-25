import { describe, expect, it } from 'vitest';
import {
  ATTACK_COST,
  COLS,
  COUNTDOWN_TICKS,
  MELD_TARGET,
  OBSTRUCTION_CELLS,
  ROWS,
} from '../src/shared/constants.js';
import {
  advance,
  applyAction,
  createGame,
  gravityTicks,
  meterMaxTicks,
  snapshotToState,
  spawnPiece,
  toSnapshot,
} from '../src/shared/engine.js';
import { defaultConfig, normalizeConfig } from '../src/shared/config.js';
import type { Cell, GameMode, GameState } from '../src/shared/types.js';

function started(
  mode: GameMode = 'coop',
  difficulty: 'zen' | 'normal' | 'hard' = 'normal',
  config: Record<string, unknown> = {},
  seed = 42,
): GameState {
  const state = createGame(mode, seed, difficulty, config);
  for (let i = 0; i < COUNTDOWN_TICKS; i++) advance(state);
  expect(state.phase).toBe('playing');
  return state;
}

function fillRow(state: GameState, y: number, from: number, to: number, p: 0 | 1): void {
  for (let x = from; x <= to; x++) {
    state.board[y * COLS + x] = { p, k: x % 7 } satisfies Cell;
  }
}

function setPiece(state: GameState, p: number, k: number, x: number, y: number, r = 0): void {
  state.players[p].piece = { k, r, x, y, fallT: 0, lockT: 0, resets: 0 };
}

describe('room rules', () => {
  it('uses a configured Meld target and keeps presets in range', () => {
    const state = createGame('coop', 3, 'normal', { target: 30 });
    expect(state.objective).toBe(30);
    expect(normalizeConfig('coop', { target: 500 }).target).toBe(100);
    expect(normalizeConfig('coop', { target: 1 }).target).toBe(5);
    expect(normalizeConfig('coop').target).toBe(MELD_TARGET);
  });

  it('Endless Together drops the target and never wins on Melds', () => {
    const state = started('coop', 'normal', { objective: 'endless' });
    expect(state.objective).toBe(0);
    state.melds = 40;
    // Complete a Meld row: the arena stays live because there is nothing to reach.
    fillRow(state, ROWS - 1, 0, 5, 0);
    setPiece(state, 1, 0, 6, 0);
    applyAction(state, 1, { t: 'hard' });
    expect(state.melds).toBe(41);
    expect(state.phase).toBe('playing');
  });

  it('reaches a long target without changing the pace', () => {
    const short = started('coop', 'normal', { target: 5 }, 7);
    const long = started('coop', 'normal', { target: 100 }, 7);
    expect(long.objective).toBe(100);
    expect(gravityTicks(long, 0)).toBe(gravityTicks(short, 0));
  });

  it('ignores rules that do not belong to the mode', () => {
    const together = normalizeConfig('coop', {
      clash: true,
      objective: 'sudden',
      meteor: 'starfall',
      target: 8,
    });
    expect(together.clash).toBe(false);
    expect(together.objective).toBe('target');
    expect(together.target).toBe(8);
    expect(together.meteor).toBe('starfall');

    const duel = normalizeConfig('versus', { meteor: 'starfall', chaos: 'frequent', clash: true });
    expect(duel.meteor).toBe('off');
    expect(duel.chaos).toBe('off');
    expect(duel.clash).toBe(true);
    expect(defaultConfig('versus').clash).toBe(false);
  });
});

describe('Meld Meter', () => {
  it('charges only while the match runs and at the difficulty rate', () => {
    const zen = createGame('coop', 9, 'zen', { meldMeter: true });
    for (let i = 0; i < COUNTDOWN_TICKS; i++) advance(zen);
    expect(zen.meter[0]).toBe(0);
    for (let i = 0; i < 100; i++) advance(zen);
    expect(zen.meter[0]).toBe(100);
    expect(meterMaxTicks(zen)).toBe(600);

    const hard = started('coop', 'hard', { meldMeter: true });
    for (let i = 0; i < 100; i++) advance(hard);
    expect(hard.meter[0]).toBe(100);
    expect(meterMaxTicks(hard)).toBe(2400);

    const off = started('coop', 'normal', { meldMeter: false });
    for (let i = 0; i < 100; i++) advance(off);
    expect(off.meter[0]).toBe(0);
  });

  it('dissolves the locked arena without scoring or touching the active pieces', () => {
    const state = started('coop', 'normal', { meldMeter: true });
    fillRow(state, ROWS - 1, 0, 4, 0);
    fillRow(state, ROWS - 2, 5, 9, 1);
    const before = state.players.map((player) => ({ ...player.piece! }));
    state.lines = 0;
    state.melds = 0;
    state.score = 0;
    state.meter[0] = meterMaxTicks(state);

    expect(applyAction(state, 0, { t: 'meter' })).toBe(true);
    expect(state.board.every((cell) => cell === null)).toBe(true);
    expect(state.lines).toBe(0);
    expect(state.melds).toBe(0);
    expect(state.score).toBe(0);
    expect(state.meter[0]).toBe(0);
    expect(state.events.some((event) => event.type === 'meter' && event.p === 0)).toBe(true);
    for (let p = 0; p < before.length; p++) {
      expect(state.players[p].piece).toMatchObject(before[p]);
    }

    // The meter is empty: a second activation in the same instant does nothing.
    expect(applyAction(state, 0, { t: 'meter' })).toBe(false);
    expect(applyAction(state, 1, { t: 'meter' })).toBe(false);
  });

  it('cannot double-clear when both players activate together', () => {
    const state = started('coop', 'normal', { meldMeter: true });
    fillRow(state, ROWS - 1, 0, 9, 0);
    state.meter[0] = meterMaxTicks(state);
    state.meter[1] = meterMaxTicks(state);
    expect(applyAction(state, 0, { t: 'meter' })).toBe(true);
    expect(applyAction(state, 1, { t: 'meter' })).toBe(false);
    expect(state.events.filter((event) => event.type === 'meter')).toHaveLength(1);
    // The arena does not report a line or Meld for the wave.
    expect(state.lines).toBe(0);
    expect(state.melds).toBe(0);
  });

  it('is a personal recovery tool in a Duel', () => {
    const state = started('versus', 'normal', { meldMeter: true });
    state.board[(ROWS - 1) * COLS] = { p: 0, k: 1 };
    state.board[(ROWS - 1) * COLS + 1] = { p: 1, k: 1 };
    state.meter[0] = meterMaxTicks(state);
    expect(applyAction(state, 0, { t: 'meter' })).toBe(true);
    expect(state.board[(ROWS - 1) * COLS]).toBeNull();
    expect(state.board[(ROWS - 1) * COLS + 1]).toEqual({ p: 1, k: 1 });
  });
});

describe('combo chains', () => {
  it('escalates consecutive clears and resets after the window', () => {
    const state = started('coop');
    fillRow(state, ROWS - 1, 0, 5, 0);
    setPiece(state, 0, 0, 6, 0);
    applyAction(state, 0, { t: 'hard' });
    let clears = state.events.filter((event) => event.type === 'clear');
    expect(clears[clears.length - 1].combo).toBe(1);

    fillRow(state, ROWS - 1, 0, 5, 1);
    setPiece(state, 0, 0, 6, 0);
    applyAction(state, 0, { t: 'hard' });
    clears = state.events.filter((event) => event.type === 'clear');
    expect(clears[clears.length - 1].combo).toBe(2);

    // Let the chain window close without a clear.
    for (let i = 0; i < 130; i++) advance(state);
    expect(state.combo).toBe(0);
    fillRow(state, ROWS - 1, 0, 5, 0);
    setPiece(state, 0, 0, 6, 0);
    applyAction(state, 0, { t: 'hard' });
    clears = state.events.filter((event) => event.type === 'clear');
    expect(clears[clears.length - 1].combo).toBe(1);
  });
});

describe('meteor storm', () => {
  it('destroys its cell and orthogonal neighbours without line credit', () => {
    const state = started('coop', 'normal', { meteor: 'standard' });
    state.board[(ROWS - 1) * COLS + 3] = { p: 0, k: 1 };
    state.board[(ROWS - 1) * COLS + 4] = { p: 0, k: 2 };
    state.board[(ROWS - 1) * COLS + 5] = { p: 1, k: 3 };
    state.board[(ROWS - 2) * COLS + 4] = { p: 0, k: 4 };
    const lines = state.lines;
    const melds = state.melds;
    state.meteors = [{ col: 4, row: ROWS - 1, at: state.tick + 1, star: false }];
    advance(state);

    expect(state.meteors).toHaveLength(0);
    expect(state.board[(ROWS - 1) * COLS + 4]).toBeNull();
    expect(state.board[(ROWS - 1) * COLS + 3]).toBeNull();
    expect(state.board[(ROWS - 2) * COLS + 4]).toBeNull();
    expect(state.lines).toBe(lines);
    expect(state.melds).toBe(melds);
    expect(state.events.some((event) => event.type === 'meteor' && event.n === 4)).toBe(true);
  });

  it('Starfall clears a wider area', () => {
    const state = started('coop', 'normal', { meteor: 'starfall' });
    for (let y = ROWS - 3; y < ROWS; y++) {
      for (let x = 3; x <= 5; x++) state.board[y * COLS + x] = { p: 0, k: 1 };
    }
    state.meteors = [{ col: 4, row: ROWS - 2, at: state.tick + 1, star: true }];
    advance(state);
    const meteor = state.events.filter((event) => event.type === 'meteor').pop();
    expect(meteor?.star).toBe(true);
    expect(meteor?.n).toBe(9);
    expect(state.lines).toBe(0);
  });

  it('stays off when the room says off', () => {
    const state = started('coop', 'normal', { meteor: 'off' });
    for (let i = 0; i < 900; i++) advance(state);
    expect(state.meteors).toHaveLength(0);
    expect(state.nextMeteorTick).toBe(0);
  });
});

describe('chaos events', () => {
  it('announces before it starts, runs one at a time, and never repeats', () => {
    const state = started('coop', 'normal', { chaos: 'frequent' });
    state.nextChaosTick = state.tick;
    advance(state);
    expect(state.chaos).not.toBeNull();
    const first = state.chaos!;
    const firstKind = first.kind;
    expect(first.start).toBeGreaterThan(state.tick);
    expect(state.events.some((event) => event.type === 'chaos')).toBe(true);

    // Before the start tick the effect is inert even though it is announced.
    expect(gravityTicks(state, 0)).toBe(
      gravityTicks({ ...state, chaos: null } as GameState, 0),
    );

    while (state.chaos) advance(state);
    expect(state.chaos).toBeNull();
    expect(state.events.some((event) => event.type === 'chaosEnd')).toBe(true);
    state.nextChaosTick = state.tick;
    advance(state);
    expect(state.chaos).not.toBeNull();
    expect(state.chaos!.kind).not.toBe(firstKind);
    // The scheduler never picks the same kind twice in a row.
    expect(state.events.filter((event) => event.type === 'chaos')).toHaveLength(2);
  });

  it('Low Gravity slows the fall and Gravity Surge speeds it up', () => {
    const state = started('coop', 'normal', { chaos: 'occasional' });
    const base = gravityTicks(state, 0);
    state.chaos = { kind: 'lowGravity', start: state.tick, end: state.tick + 100 };
    expect(gravityTicks(state, 0)).toBeGreaterThan(base);
    state.chaos = { kind: 'surge', start: state.tick, end: state.tick + 100 };
    expect(gravityTicks(state, 0)).toBeLessThan(base);
  });
});

describe('Clash Attack', () => {
  it('spends charge on an obstruction and then cools down', () => {
    const state = started('versus', 'normal', { clash: true });
    for (let y = ROWS - 4; y < ROWS; y++) state.board[y * COLS] = { p: 1, k: 1 };
    const before = state.board.filter(Boolean).length;
    state.attack[0] = ATTACK_COST;
    expect(applyAction(state, 0, { t: 'clash', kind: 'obstruction' })).toBe(true);
    expect(state.board.filter(Boolean).length).toBe(before + OBSTRUCTION_CELLS);
    expect(state.attack[0]).toBe(0);
    expect(state.events.some((event) => event.type === 'attack' && event.kind === 'obstruction')).toBe(true);

    state.attack[0] = ATTACK_COST;
    expect(applyAction(state, 0, { t: 'clash', kind: 'surge' })).toBe(false);
  });

  it('surges the rival without touching your own pace', () => {
    const state = started('versus', 'normal', { clash: true });
    state.attack[0] = ATTACK_COST;
    expect(applyAction(state, 0, { t: 'clash', kind: 'surge' })).toBe(true);
    expect(state.surgeUntil[1]).toBeGreaterThan(state.tick);
    expect(gravityTicks(state, 1)).toBeLessThan(gravityTicks(state, 0));
  });

  it('shells rival crystals so a full row cannot clear until it expires', () => {
    const state = started('versus');
    state.shells = [];
    fillRow(state, ROWS - 1, 0, 9, 1);
    for (let x = 0; x < 3; x++) state.shells.push({ i: (ROWS - 1) * COLS + x, until: state.tick + 40 });

    // A lock that would otherwise clear the row passes without clearing it.
    setPiece(state, 0, 1, 2, 0);
    applyAction(state, 0, { t: 'hard' });
    expect(state.lines).toBe(0);
    expect(state.board[(ROWS - 1) * COLS + 9]).not.toBeNull();

    // Once the shells expire the standing row clears.
    state.tick += 45;
    advance(state);
    expect(state.lines).toBeGreaterThan(0);
  });

  it('does nothing when the room disables Clash', () => {
    const state = started('versus', 'normal', { clash: false });
    state.attack[0] = ATTACK_COST;
    expect(applyAction(state, 0, { t: 'clash', kind: 'surge' })).toBe(false);
    expect(state.surgeUntil[1]).toBe(0);
  });
});

describe('Sudden Death', () => {
  it('has no row target and escalates pressure over time', () => {
    const state = started('versus', 'normal', { objective: 'sudden' });
    expect(state.objective).toBe(0);
    const early = gravityTicks(state, 0);
    state.playTicks = 2400;
    expect(gravityTicks(state, 0)).toBeLessThan(early);

    state.players[0].clears = 99;
    expect(state.phase).toBe('playing');
  });

  it('is lost by the first arena to top out', () => {
    const state = started('versus', 'normal', { objective: 'sudden' });
    for (let y = 0; y < 5; y++) fillRow(state, y, 4, 9, 1);
    state.players[1].piece = null;
    // spawnPiece reports the loss through the shared match result.
    spawnPiece(state, 1);
    expect(state.phase).toBe('won');
    expect(state.winner).toBe(0);
  });
});

describe('modifier stability', () => {
  it('runs a long Duel with every modifier without breaking invariants', () => {
    const state = createGame('versus', 123, 'normal', {
      objective: 'target',
      target: 99,
      meldMeter: true,
      meteor: 'starfall',
      chaos: 'frequent',
      clash: true,
    });
    for (let i = 0; i < COUNTDOWN_TICKS; i++) advance(state);
    const kinds = ['obstruction', 'surge', 'shell'] as const;
    for (let i = 0; i < 3000 && state.phase === 'playing'; i++) {
      const p = i % 2;
      if (i % 3 === 0) applyAction(state, p, { t: 'hard' });
      if (i % 17 === 0) applyAction(state, p, { t: 'meter' });
      if (i % 23 === 0) applyAction(state, p, { t: 'clash', kind: kinds[i % kinds.length] });
      advance(state);
      expect(state.board).toHaveLength(ROWS * COLS);
      for (const value of state.meter) expect(value).toBeGreaterThanOrEqual(0);
      for (const value of state.attack) expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(['playing', 'won', 'lost']).toContain(state.phase);
  });
});

describe('rule snapshots', () => {
  it('carries rules, meter, shells, meteors and chaos to the guest', () => {
    const state = started('coop', 'normal', {
      target: 30,
      meldMeter: true,
      meteor: 'starfall',
      chaos: 'frequent',
    });
    state.meter[0] = 123;
    state.attack[0] = 2;
    state.shells = [{ i: 5, until: 999 }];
    state.meteors = [{ col: 2, row: ROWS - 1, at: 500, star: true }];
    state.chaos = { kind: 'blackout', start: 10, end: 200 };
    state.combo = 3;

    const snapshot = toSnapshot(state, [1, 2]);
    const restored = snapshotToState(snapshot, 'coop');

    expect(restored.config).toEqual(state.config);
    expect(restored.objective).toBe(30);
    expect(restored.meter).toEqual(state.meter);
    expect(restored.attack).toEqual(state.attack);
    expect(restored.shells).toEqual(state.shells);
    expect(restored.meteors).toEqual(state.meteors);
    expect(restored.chaos).toEqual(state.chaos);
    expect(restored.combo).toBe(3);
  });
});
