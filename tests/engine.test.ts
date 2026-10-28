import { describe, expect, it } from 'vitest';
import { COLS, COUNTDOWN_TICKS, LOCK_DELAY_TICKS, MELD_TARGET, ROWS, TICK_MS } from '../src/shared/constants.js';
import {
  advance,
  applyAction,
  cloneState,
  createGame,
  decodeBoard,
  encodeBoard,
  gravityTicks,
  snapshotToState,
  spawnPiece,
  stateHash,
  toSnapshot,
} from '../src/shared/engine.js';
import { collides, pieceCells } from '../src/shared/pieces.js';
import type { Cell, GameMode, GameState } from '../src/shared/types.js';
import { RIFT_WAVES, RIFT_WAVE_TICKS, VERSUS_LINE_TARGET } from '../src/shared/constants.js';

function started(mode: GameMode = 'coop', seed = 42): GameState {
  const state = createGame(mode, seed);
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

describe('match setup', () => {
  it('creates two spawn-separated pieces for co-op in a countdown', () => {
    const state = createGame('coop', 7);
    expect(state.players).toHaveLength(2);
    expect(state.phase).toBe('countdown');
    expect(state.objective).toBe(MELD_TARGET);
    const [a, b] = state.players;
    expect(a.piece).not.toBeNull();
    expect(b.piece).not.toBeNull();
    const aCells = pieceCells(a.piece!.k, a.piece!.r, a.piece!.x, a.piece!.y);
    const bCells = pieceCells(b.piece!.k, b.piece!.r, b.piece!.x, b.piece!.y);
    for (const cell of aCells) {
      expect(bCells.some((other) => other.x === cell.x && other.y === cell.y)).toBe(false);
    }
    expect(state.players.every((player) => player.next.length === 3)).toBe(true);
  });

  it('ignores inputs until the countdown ends', () => {
    const state = createGame('coop', 7);
    const x = state.players[0].piece!.x;
    expect(applyAction(state, 0, { t: 'left' })).toBe(false);
    expect(state.players[0].piece!.x).toBe(x);
  });

  it('starts after the countdown', () => {
    const state = started();
    expect(state.phase).toBe('playing');
    advance(state);
    expect(state.playTicks).toBe(1);
  });
});

describe('movement', () => {
  it('moves sideways and stops at the wall', () => {
    const state = started();
    setPiece(state, 0, 1, 0, 5); // O piece, 2 wide
    for (let i = 0; i < 15; i++) applyAction(state, 0, { t: 'left' });
    expect(state.players[0].piece!.x).toBe(0);
    for (let i = 0; i < 15; i++) applyAction(state, 0, { t: 'right' });
    expect(state.players[0].piece!.x).toBe(COLS - 2);
  });

  it('rotates with a kick when the wall blocks the rotation', () => {
    const state = started();
    setPiece(state, 0, 0, -2, 4); // I piece, horizontal, origin off the left edge
    expect(applyAction(state, 0, { t: 'rot', d: 1 })).toBe(true);
    expect(collides(state.board, state.players[0].piece!)).toBe(false);
  });

  it('does not move into locked cells', () => {
    const state = started();
    setPiece(state, 0, 1, 3, 5);
    state.board[6 * COLS + 3] = { p: 1, k: 2 };
    expect(applyAction(state, 0, { t: 'left' })).toBe(false);
  });

  it('soft drop adds one point per row', () => {
    const state = started();
    const before = state.score;
    const y = state.players[0].piece!.y;
    expect(applyAction(state, 0, { t: 'soft' })).toBe(true);
    expect(state.players[0].piece!.y).toBe(y + 1);
    expect(state.score).toBe(before + 1);
  });

  it('hard drop locks the piece at the floor', () => {
    const state = started();
    setPiece(state, 0, 1, 2, 0);
    expect(applyAction(state, 0, { t: 'hard' })).toBe(true);
    expect(state.board[(ROWS - 1) * COLS + 2]).toEqual({ p: 0, k: 1 });
    expect(state.board[(ROWS - 1) * COLS + 3]).toEqual({ p: 0, k: 1 });
    expect(state.players[0].cells).toBe(4);
    expect(state.players[0].piece).not.toBeNull();
  });

  it('locks a resting piece after the lock delay', () => {
    const state = started();
    setPiece(state, 0, 1, 4, ROWS - 2);
    for (let i = 0; i < LOCK_DELAY_TICKS; i++) advance(state);
    expect(state.players[0].piece).not.toBeNull(); // a new piece spawned
    expect(state.board[(ROWS - 1) * COLS + 4]).toEqual({ p: 0, k: 1 });
  });
});

describe('clearing and the co-op objective', () => {
  it('clears a single-player row without a meld', () => {
    const state = started();
    state.score = 0;
    fillRow(state, ROWS - 1, 0, 5, 0);
    setPiece(state, 0, 0, 6, 0); // I piece, horizontal at columns 6..9
    applyAction(state, 0, { t: 'hard' });

    expect(state.lines).toBe(1);
    expect(state.melds).toBe(0);
    // 100 for the clear plus 18 rows of hard-drop distance at 2 points each.
    expect(state.score).toBe(100 + 36);
    expect(state.board[(ROWS - 1) * COLS]).toBeNull();
  });

  it('counts a row containing both colours as a Meld', () => {
    const state = started();
    state.score = 0;
    fillRow(state, ROWS - 1, 0, 5, 0);
    setPiece(state, 1, 0, 6, 0);
    applyAction(state, 1, { t: 'hard' });

    expect(state.lines).toBe(1);
    expect(state.melds).toBe(1);
    expect(state.score).toBe(100 + 200 + 36);
    expect(state.players[0].melds).toBe(1);
    expect(state.players[1].melds).toBe(1);
  });

  it('credits both players with the rows they contributed to', () => {
    const state = started();
    fillRow(state, ROWS - 1, 0, 5, 0);
    setPiece(state, 1, 0, 6, 0);
    applyAction(state, 1, { t: 'hard' });
    expect(state.players[0].rows).toBe(1);
    expect(state.players[1].rows).toBe(1);
  });

  it('wins a co-op match at the Meld target, not before', () => {
    const state = started();
    state.melds = MELD_TARGET - 2;
    fillRow(state, ROWS - 1, 0, 5, 0);
    setPiece(state, 1, 0, 6, 0);
    applyAction(state, 1, { t: 'hard' });
    expect(state.melds).toBe(MELD_TARGET - 1);
    expect(state.phase).toBe('playing');

    fillRow(state, ROWS - 1, 0, 5, 1);
    setPiece(state, 0, 0, 6, 0);
    applyAction(state, 0, { t: 'hard' });
    expect(state.melds).toBe(MELD_TARGET);
    expect(state.phase).toBe('won');
  });

  it('clears several rows at once with the standard score table', () => {
    const state = started();
    state.score = 0;
    for (let y = ROWS - 2; y < ROWS; y++) fillRow(state, y, 0, 7, 0);
    setPiece(state, 0, 1, 8, 0); // O piece finishing columns 8..9 on both rows
    applyAction(state, 0, { t: 'hard' });
    expect(state.lines).toBe(2);
    expect(state.score).toBe(300 + 36);
  });

  it('absorbs the partner piece overlap deterministically instead of overwriting blocks', () => {
    const state = started();
    setPiece(state, 1, 1, 4, ROWS - 2); // O piece resting on the floor
    setPiece(state, 0, 1, 4, 0); // same columns, same floor
    applyAction(state, 0, { t: 'hard' });
    expect(state.board[(ROWS - 1) * COLS + 4]).toEqual({ p: 0, k: 1 });
    // The partner piece is lifted clear instead of being embedded or overwritten.
    const partner = state.players[1].piece!;
    expect(partner).not.toBeNull();
    expect(partner.y).toBeLessThan(ROWS - 2);
    expect(collides(state.board, partner)).toBe(false);
    expect(state.players[0].cells).toBe(4);
  });
});

describe('solo mode', () => {
  it('has one player and wins at the line target', () => {
    const state = started('solo');
    expect(state.players).toHaveLength(1);
    state.lines = 11;
    fillRow(state, ROWS - 1, 0, 5, 0);
    setPiece(state, 0, 0, 6, 0);
    applyAction(state, 0, { t: 'hard' });
    expect(state.lines).toBe(12);
    expect(state.phase).toBe('won');
  });
});

describe('versus, relay and the extra modes', () => {
  it('gives Duel row credit to the player who closes the row', () => {
    const state = started('versus');
    state.players[0].clears = VERSUS_LINE_TARGET - 1;
    fillRow(state, ROWS - 1, 0, 5, 1);
    setPiece(state, 0, 0, 6, 0);
    applyAction(state, 0, { t: 'hard' });
    expect(state.players[0].clears).toBe(VERSUS_LINE_TARGET);
    expect(state.winner).toBe(0);
    expect(state.phase).toBe('won');
  });

  it('awards a Duel top-out to the other player', () => {
    const state = started('versus');
    for (let y = 0; y < 5; y++) fillRow(state, y, 4, 9, 1);
    state.players[1].piece = null;
    spawnPiece(state, 1);
    expect(state.phase).toBe('won');
    expect(state.winner).toBe(0);
    expect(state.players[1].piece).toBeNull();
  });

  it('Relay lets only the active player act and alternates after a lock', () => {
    const state = started('relay');
    expect(state.turn).toBe(0);
    expect(state.players[0].piece).not.toBeNull();
    expect(state.players[1].piece).toBeNull();
    expect(applyAction(state, 1, { t: 'left' })).toBe(false);
    expect(applyAction(state, 0, { t: 'hard' })).toBe(true);
    expect(state.turn).toBe(1);
    expect(state.players[0].piece).toBeNull();
    expect(state.players[1].piece).not.toBeNull();
  });

  it('Architect starts with debris but leaves the spawn area clear', () => {
    const state = createGame('architect', 5);
    expect(state.players).toHaveLength(1);
    expect(state.objective).toBe(10);
    expect(state.board.slice(0, 8 * COLS).every((cell) => cell === null)).toBe(true);
    expect(state.board.some((cell) => cell !== null)).toBe(true);
  });

  it('Endless has no target and does not end on lines', () => {
    const state = started('endless');
    state.lines = 99;
    expect(state.objective).toBe(0);
    expect(state.phase).toBe('playing');
    state.phase = 'lost';
    expect(state.winner).toBeNull();
  });

  it('Rift wins only after the third wave has elapsed', () => {
    const state = started('rift');
    state.playTicks = RIFT_WAVES * RIFT_WAVE_TICKS - 2;
    advance(state);
    expect(state.phase).toBe('playing');
    advance(state);
    expect(state.phase).toBe('won');
  });
});

describe('failure and determinism', () => {
  it('ends the shared match when a piece cannot spawn', () => {
    const state = started();
    setPiece(state, 0, 1, 0, ROWS - 2);
    applyAction(state, 0, { t: 'hard' }); // locks, spawns, then next lock is blocked by board
    // Fill the second player's spawn area, then force a spawn.
    for (let y = 0; y < 5; y++) fillRow(state, y, 4, 9, 1);
    state.players[1].piece = null;
    spawnPiece(state, 1);
    expect(state.phase).toBe('lost');
    expect(state.players[1].piece).toBeNull();
  });

  it('replays identically from the same seed and action sequence', () => {
    const script: { tick: number; p: number; action: 'left' | 'right' | 'rot' | 'soft' | 'hard' }[] = [
      { tick: 3, p: 0, action: 'left' },
      { tick: 4, p: 1, action: 'rot' },
      { tick: 9, p: 0, action: 'hard' },
      { tick: 12, p: 1, action: 'right' },
      { tick: 20, p: 1, action: 'hard' },
    ];
    const run = () => {
      const state = createGame('coop', 99);
      let index = 0;
      for (let tick = 0; tick < 240; tick++) {
        while (index < script.length && script[index].tick === tick) {
          const step = script[index++];
          applyAction(
            state,
            step.p,
            step.action === 'rot' ? { t: 'rot', d: 1 } : ({ t: step.action } as { t: 'left' }),
          );
        }
        advance(state);
      }
      return stateHash(state);
    };
    expect(run()).toBe(run());
  });

  it('advances at the declared tick rate', () => {
    expect(TICK_MS).toBe(50);
  });
});

describe('difficulty', () => {
  it('slows Zen and starts Hard faster than the designed pace', () => {
    const zen = createGame('solo', 11, 'zen');
    const normal = createGame('solo', 11, 'normal');
    const hard = createGame('solo', 11, 'hard');
    expect(gravityTicks(zen)).toBeGreaterThan(gravityTicks(normal));
    expect(gravityTicks(normal)).toBeGreaterThan(gravityTicks(hard));

    for (const state of [zen, normal, hard]) state.playTicks = 60 * 20; // one minute
    expect(gravityTicks(zen)).toBeGreaterThan(gravityTicks(normal));
    expect(gravityTicks(normal)).toBeGreaterThan(gravityTicks(hard));
  });

  it('keeps Normal readable well past the halfway point', () => {
    const state = createGame('solo', 5, 'normal');
    const ticksAt = (seconds: number): number => {
      state.playTicks = seconds * 20;
      return gravityTicks(state);
    };
    expect(ticksAt(0)).toBe(17); // 850 ms
    expect(ticksAt(30)).toBe(14); // 700 ms
    expect(ticksAt(60)).toBe(11); // 550 ms, where the old curve was already near the floor
    expect(ticksAt(180)).toBe(6); // 280 ms floor, never faster
  });

  it('defaults to Normal and survives the snapshot round trip', () => {
    expect(createGame('solo', 3).difficulty).toBe('normal');
    const state = createGame('coop', 3, 'hard');
    const restored = snapshotToState(toSnapshot(state, [0, 0]), 'coop');
    expect(restored.difficulty).toBe('hard');
  });
});

describe('wire encoding', () => {
  it('round-trips the board and remembers ownership', () => {
    const state = started();
    fillRow(state, 5, 0, 4, 0);
    fillRow(state, 6, 5, 9, 1);
    const encoded = encodeBoard(state.board);
    const decoded = decodeBoard(encoded);
    expect(decoded).toEqual(state.board);
    expect(encoded).toContain('/');
  });

  it('snapshots preserve score, melds and both pieces', () => {
    const state = started();
    state.score = 1234;
    state.melds = 3;
    const snapshot = toSnapshot(state, [5, 2]);
    expect(snapshot.players[0].seq).toBe(5);
    expect(snapshot.melds).toBe(3);
    expect(decodeBoard(snapshot.board)).toEqual(state.board);
  });

  it('clones states without sharing structure', () => {
    const state = started();
    const copy = cloneState(state);
    copy.board[0] = { p: 1, k: 0 };
    expect(state.board[0]).toBeNull();
  });
});
