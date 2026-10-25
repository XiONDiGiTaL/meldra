import {
  ARCHITECT_LINE_TARGET,
  ATTACK_COOLDOWN_TICKS,
  ATTACK_COST,
  ATTACK_MAX_POINTS,
  CHAOS_ANNOUNCE_TICKS,
  CHAOS_DURATION_TICKS,
  CHAOS_INTERVAL_TICKS,
  COLS,
  COMBO_WINDOW_TICKS,
  COUNTDOWN_TICKS,
  DIFFICULTY_PROFILES,
  LOCK_DELAY_TICKS,
  MAX_LOCK_RESETS,
  MELD_BONUS,
  MELD_TARGET,
  METEOR_LEAD_TICKS,
  METEOR_MAX_TICKS,
  METEOR_MIN_TICKS,
  METER_CHARGE_SECONDS,
  OBSTRUCTION_CELLS,
  PING_COOLDOWN_TICKS,
  RIFT_WAVES,
  RIFT_WAVE_TICKS,
  ROWS,
  SHELL_MAX_CELLS,
  SHELL_TICKS,
  SOLO_LINE_TARGET,
  SPAWN_X,
  STARFALL_CHANCE,
  SUDDEN_DEATH_FLOOR,
  SURGE_TICKS,
  TICK_MS,
} from './constants.js';
import { normalizeConfig, type MatchConfig } from './config.js';
import { KIND_NAMES, SHAPES, collides, pieceCells } from './pieces.js';
import type {
  Action,
  AttackKind,
  Cell,
  ChaosKind,
  Difficulty,
  GameEvent,
  GameMode,
  GameState,
  Meteor,
  PlayerRuntime,
  Snapshot,
} from './types.js';

const LINE_SCORE = [0, 100, 300, 500, 800];

function xorshift(state: GameState, p: number): number {
  let x = state.rng[p] >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  state.rng[p] = x;
  return x;
}

function randRange(state: GameState, min: number, max: number): number {
  return min + (xorshift(state, 0) % Math.max(1, max - min + 1));
}

function seedRng(seed: number): number {
  // Any non-zero value works for xorshift32.
  const s = (seed ^ 0x9e3779b9) >>> 0;
  return s === 0 ? 0x1234567 : s;
}

function shuffledBag(state: GameState, p: number): number[] {
  const bag = KIND_NAMES.map((_, i) => i);
  for (let i = bag.length - 1; i > 0; i--) {
    const j = xorshift(state, p) % (i + 1);
    const tmp = bag[i];
    bag[i] = bag[j];
    bag[j] = tmp;
  }
  return bag;
}

function drawKind(state: GameState, p: number): number {
  if (state.bags[p].length === 0) state.bags[p] = shuffledBag(state, p);
  return state.bags[p].pop() as number;
}

function refillQueue(state: GameState, p: number): void {
  const runtime = state.players[p];
  while (runtime.next.length < 3) runtime.next.push(drawKind(state, p));
}

function pushEvent(state: GameState, event: Omit<GameEvent, 'id' | 'tick'>): void {
  state.eventSeq += 1;
  state.events.push({ id: state.eventSeq, tick: state.tick, ...event });
  if (state.events.length > 48) state.events.splice(0, state.events.length - 48);
}

/** Ticks the Meld Meter needs to fill. Zen 30 s, Normal 60 s, Hard 120 s. */
export function meterMaxTicks(state: GameState): number {
  const seconds = METER_CHARGE_SECONDS[state.difficulty] ?? METER_CHARGE_SECONDS.normal;
  return Math.round((seconds * 1000) / TICK_MS);
}

function chaosActive(state: GameState): ChaosKind | null {
  const chaos = state.chaos;
  if (!chaos) return null;
  return state.tick >= chaos.start && state.tick < chaos.end ? chaos.kind : null;
}

export function gravityTicks(state: GameState, p = 0): number {
  const profile = DIFFICULTY_PROFILES[state.difficulty];
  const seconds = (state.playTicks * TICK_MS) / 1000;
  let interval = Math.max(profile.minMs, profile.baseMs - seconds * profile.rampMsPerSec);
  // Sudden Death applies a second, slower ramp on top of the chosen pace so matches end.
  if (state.mode === 'versus' && state.config.objective === 'sudden') {
    interval *= Math.max(SUDDEN_DEATH_FLOOR, 1 - seconds / 120);
  }
  const chaos = chaosActive(state);
  if (chaos === 'lowGravity') interval *= 1.55;
  if (chaos === 'surge') interval *= 0.62;
  if (state.surgeUntil[p] > state.tick) interval *= 0.55;
  return Math.max(2, Math.round(interval / TICK_MS));
}

function endMatch(state: GameState, phase: 'won' | 'lost', by?: number): void {
  if (state.phase === 'won' || state.phase === 'lost') return;
  state.phase = phase;
  state.phaseTick = 0;
  pushEvent(state, { type: phase === 'won' ? 'win' : 'lose', p: by });
}

export function spawnPiece(state: GameState, p: number): void {
  const runtime = state.players[p];
  refillQueue(state, p);
  const kind = runtime.next.shift() as number;
  const piece = { k: kind, r: 0, x: SPAWN_X[p] ?? 1, y: 0, fallT: 0, lockT: 0, resets: 0 };
  refillQueue(state, p);
  if (collides(state.board, piece)) {
    runtime.piece = null;
    if (state.mode === 'versus') {
      // In a Duel a blocked spawn loses the match for that player, not the room.
      state.winner = 1 - p;
      endMatch(state, 'won', state.winner);
    } else {
      endMatch(state, 'lost', p);
    }
    return;
  }
  runtime.piece = piece;
}

function isShelled(state: GameState, index: number): boolean {
  for (const shell of state.shells) {
    if (shell.i === index && shell.until > state.tick) return true;
  }
  return false;
}

function pruneShells(state: GameState): void {
  if (state.shells.length === 0) return;
  state.shells = state.shells.filter((shell) => shell.until > state.tick && Boolean(state.board[shell.i]));
}

/** Drops crystal fragments into the rival arena. Returns false when no safe column exists. */
function dropObstruction(state: GameState, target: number, attacker: number): boolean {
  const offset = xorshift(state, 0) % COLS;
  for (let step = 0; step < COLS; step++) {
    const x = (offset + step) % COLS;
    const top = topOfColumn(state, x);
    if (top < OBSTRUCTION_CELLS + 1) continue;
    const cells: number[] = [];
    for (let n = 1; n <= OBSTRUCTION_CELLS; n++) {
      const index = (top - n) * COLS + x;
      if (index >= 0 && !state.board[index]) cells.push(index);
    }
    if (cells.length === 0) continue;
    for (const index of cells) state.board[index] = { p: attacker === 0 ? 0 : 1, k: 2 + (index % 3) };
    // A full row still clears normally, for the player whose arena received the crystals.
    clearRows(state, target);
    return true;
  }
  return false;
}

/** Shells the tallest crystals of the target so they cannot clear for a few seconds. */
function applyShell(state: GameState): boolean {
  const candidates: number[] = [];
  for (let y = 0; y < ROWS && candidates.length < SHELL_MAX_CELLS; y++) {
    for (let x = 0; x < COLS && candidates.length < SHELL_MAX_CELLS; x++) {
      const index = y * COLS + x;
      if (!state.board[index] || isShelled(state, index)) continue;
      candidates.push(index);
    }
  }
  if (candidates.length === 0) return false;
  for (const index of candidates) state.shells.push({ i: index, until: state.tick + SHELL_TICKS });
  return true;
}

function useAttack(state: GameState, p: number, kind: AttackKind): boolean {
  if (!state.config.clash || state.mode !== 'versus') return false;
  if (state.phase !== 'playing') return false;
  if ((state.attack[p] ?? 0) < ATTACK_COST) return false;
  if ((state.attackCooldown[p] ?? 0) > state.tick) return false;
  const target = 1 - p;
  let applied = false;
  if (kind === 'obstruction') applied = dropObstruction(state, target, p);
  else if (kind === 'surge') {
    state.surgeUntil[target] = state.tick + SURGE_TICKS;
    applied = true;
  } else if (kind === 'shell') applied = applyShell(state);
  if (!applied) return false;
  state.attack[p] -= ATTACK_COST;
  state.attackCooldown[p] = state.tick + ATTACK_COOLDOWN_TICKS;
  pushEvent(state, { type: 'attack', p, kind, n: ATTACK_COST });
  return true;
}

/** Spends a full Meld Meter. Clears locked crystals without scoring a clear or a Meld. */
export function useMeter(state: GameState, p: number): boolean {
  if (!state.config.meldMeter) return false;
  if (state.phase !== 'playing') return false;
  if ((state.meter[p] ?? 0) < meterMaxTicks(state)) return false;
  let removed = 0;
  for (let i = 0; i < state.board.length; i++) {
    const cell = state.board[i];
    if (!cell) continue;
    // A Duel meter is a personal recovery tool: it only dissolves your own crystals.
    if (state.mode === 'versus' && cell.p !== p) continue;
    state.board[i] = null;
    removed += 1;
  }
  if (removed === 0) return false;
  pruneShells(state);
  state.meter[p] = 0;
  // Active pieces are deliberately untouched: the wave dissolves locked crystals only.
  pushEvent(state, { type: 'meter', p, n: removed });
  return true;
}

function topOfColumn(state: GameState, x: number): number {
  for (let y = 0; y < ROWS; y++) {
    if (state.board[y * COLS + x]) return y;
  }
  return ROWS;
}

function clearRows(state: GameState, locker: number): void {
  const full: number[] = [];
  for (let y = 0; y < ROWS; y++) {
    let complete = true;
    for (let x = 0; x < COLS; x++) {
      const index = y * COLS + x;
      if (!state.board[index] || isShelled(state, index)) {
        complete = false;
        break;
      }
    }
    if (complete) full.push(y);
  }
  if (full.length === 0) return;

  const meldRows: number[] = [];
  for (const y of full) {
    const owners = new Set<number>();
    for (let x = 0; x < COLS; x++) {
      const cell = state.board[y * COLS + x];
      if (cell) owners.add(cell.p);
    }
    if (owners.size > 1) meldRows.push(y);
  }

  // Contribution credit: a player gets a "row joined" for every cleared row holding their cells.
  for (const y of full) {
    const owners = new Set<number>();
    for (let x = 0; x < COLS; x++) {
      const cell = state.board[y * COLS + x];
      if (cell) owners.add(cell.p);
    }
    for (const owner of owners) {
      const runtime = state.players[owner];
      if (!runtime) continue;
      runtime.rows += 1;
      if (meldRows.includes(y)) runtime.melds += 1;
    }
  }

  const cleared = new Set(full);
  if (state.shells.length > 0) {
    state.shells = state.shells.flatMap((shell) => {
      const row = Math.floor(shell.i / COLS);
      if (cleared.has(row)) return [];
      const shift = full.filter((y) => y < row).length;
      return [{ i: (row + shift) * COLS + (shell.i % COLS), until: shell.until }];
    });
  }

  const survivors: (Cell | null)[] = [];
  for (let y = 0; y < ROWS; y++) {
    if (cleared.has(y)) continue;
    for (let x = 0; x < COLS; x++) survivors.push(state.board[y * COLS + x]);
  }
  const clean: (Cell | null)[] = new Array(full.length * COLS).fill(null);
  state.board = clean.concat(survivors);

  state.lines += full.length;
  state.melds += meldRows.length;
  state.score += LINE_SCORE[Math.min(full.length, 4)] + meldRows.length * MELD_BONUS;

  // Chaotic play should never read as noise: the chain depth is carried on the clear event.
  state.combo = state.tick <= state.comboUntil ? Math.min(9, state.combo + 1) : 1;
  state.comboUntil = state.tick + COMBO_WINDOW_TICKS;

  pushEvent(state, { type: 'clear', p: locker, rows: [...full], n: full.length, combo: state.combo });
  if (meldRows.length > 0) {
    pushEvent(state, { type: 'meld', p: locker, rows: [...meldRows], n: meldRows.length, combo: state.combo });
  }

  const closer = state.players[locker];
  if (closer) closer.clears += full.length;
  if (state.config.clash && locker >= 0) {
    state.attack[locker] = Math.min(ATTACK_MAX_POINTS, (state.attack[locker] ?? 0) + full.length);
  }

  if (state.mode === 'versus') {
    if (state.objective > 0 && closer && closer.clears >= state.objective) {
      state.winner = locker;
      endMatch(state, 'won', locker);
    }
  } else if (state.mode === 'coop' || state.mode === 'relay') {
    if (state.objective > 0 && state.melds >= state.objective) endMatch(state, 'won', locker);
  } else if (state.mode === 'solo' || state.mode === 'architect') {
    if (state.lines >= state.objective) endMatch(state, 'won', locker);
  }
}

function lockPiece(state: GameState, p: number): void {
  const runtime = state.players[p];
  const piece = runtime.piece;
  if (!piece) return;
  for (const c of pieceCells(piece.k, piece.r, piece.x, piece.y)) {
    if (c.y < 0) continue;
    const index = c.y * COLS + c.x;
    // If the partner locked into a cell this piece still occupies (only possible when both
    // pieces land on the same tick), the first locked cell wins and this cell is absorbed.
    if (!state.board[index]) state.board[index] = { p: (p === 0 ? 0 : 1) as 0 | 1, k: piece.k };
  }
  runtime.cells += 4;
  runtime.piece = null;
  pushEvent(state, { type: 'lock', p });

  // Lift the partner's active piece out of the newly locked cells instead of leaving it
  // embedded. Overlaps are rare, but they must resolve deterministically.
  for (let other = 0; other < state.players.length; other++) {
    if (other === p) continue;
    const partner = state.players[other].piece;
    if (!partner) continue;
    let guard = 0;
    while (collides(state.board, partner) && partner.y > 0 && guard < 4) {
      partner.y -= 1;
      partner.fallT = 0;
      guard += 1;
    }
  }

  clearRows(state, p);
  if (state.phase !== 'playing') return;
  if (state.mode === 'relay') {
    // Only one piece is in play; the next player receives it after every lock.
    state.turn = (p + 1) % state.players.length;
    spawnPiece(state, state.turn);
    return;
  }
  spawnPiece(state, p);
}

function touchLock(state: GameState, p: number): void {
  const piece = state.players[p].piece;
  if (!piece) return;
  if (!collides(state.board, { ...piece, y: piece.y + 1 })) return;
  if (piece.resets >= MAX_LOCK_RESETS) return;
  piece.lockT = 0;
  piece.resets += 1;
}

const ONLINE_TWO_PLAYER: GameMode[] = ['coop', 'versus', 'relay', 'rift'];

function objectiveFor(mode: GameMode, config: MatchConfig): number {
  switch (mode) {
    case 'coop':
      return config.objective === 'endless' ? 0 : config.target;
    case 'relay':
      return MELD_TARGET;
    case 'versus':
      return config.objective === 'sudden' ? 0 : config.target;
    case 'solo':
      return SOLO_LINE_TARGET;
    case 'architect':
      return ARCHITECT_LINE_TARGET;
    case 'rift':
      return RIFT_WAVES;
    default:
      return 0;
  }
}

export function createGame(
  mode: GameMode,
  seed = Date.now() >>> 0,
  difficulty: Difficulty = 'normal',
  config: Partial<MatchConfig> | MatchConfig = normalizeConfig(mode),
): GameState {
  const rules = normalizeConfig(mode, config);
  const count = ONLINE_TWO_PLAYER.includes(mode) ? 2 : 1;
  const state: GameState = {
    mode,
    difficulty,
    tick: 0,
    playTicks: 0,
    phase: 'countdown',
    phaseTick: 0,
    board: new Array(ROWS * COLS).fill(null),
    players: [],
    rng: [],
    bags: [],
    score: 0,
    lines: 0,
    melds: 0,
    objective: objectiveFor(mode, rules),
    winner: null,
    turn: 0,
    config: rules,
    meter: [],
    attack: [],
    attackCooldown: [],
    surgeUntil: [],
    shells: [],
    meteors: [],
    nextMeteorTick: 0,
    chaos: null,
    nextChaosTick: 0,
    lastChaos: null,
    combo: 0,
    comboUntil: 0,
    events: [],
    eventSeq: 0,
  };
  for (let p = 0; p < count; p++) {
    const runtime: PlayerRuntime = {
      piece: null,
      next: [],
      cells: 0,
      rows: 0,
      melds: 0,
      clears: 0,
      lastPingTick: -PING_COOLDOWN_TICKS,
    };
    state.players.push(runtime);
    state.rng.push(seedRng(seed + p * 7919));
    state.bags.push([]);
    state.meter.push(0);
    state.attack.push(0);
    state.attackCooldown.push(0);
    state.surgeUntil.push(0);
  }
  // Architect starts with a deterministic half-built stack, leaving the top clear.
  if (mode === 'architect') {
    for (let y = ROWS - 6; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if ((x + y * 2) % 4 !== 0 && (x * 3 + y) % 7 !== 0) {
          state.board[y * COLS + x] = { p: 0, k: (x + y) % 7 };
        }
      }
    }
  }
  if (mode === 'relay') spawnPiece(state, 0);
  else for (let p = 0; p < count; p++) spawnPiece(state, p);
  // A fresh board cannot top out, so the phase is always the countdown here.
  state.phase = 'countdown';
  state.phaseTick = 0;
  return state;
}

/** Apply a player action immediately. Returns true when the action changed the state. */
export function applyAction(state: GameState, p: number, action: Action): boolean {
  const runtime = state.players[p];
  if (!runtime) return false;
  if (state.mode === 'relay' && state.turn !== p) return false;

  if (action.t === 'ping') {
    if (state.phase !== 'playing') return false;
    if (state.tick - runtime.lastPingTick < PING_COOLDOWN_TICKS) return false;
    const piece = runtime.piece;
    const col = action.col ?? (piece ? piece.x + Math.floor(SHAPES[piece.k].size / 2) : 4);
    runtime.lastPingTick = state.tick;
    pushEvent(state, { type: 'ping', p, col: Math.max(0, Math.min(COLS - 1, col)) });
    return true;
  }

  if (action.t === 'meter') return useMeter(state, p);
  if (action.t === 'clash') return useAttack(state, p, action.kind);

  if (state.phase !== 'playing') return false;
  const piece = runtime.piece;
  if (!piece) return false;

  switch (action.t) {
    case 'left':
    case 'right': {
      const dx = action.t === 'left' ? -1 : 1;
      if (collides(state.board, { ...piece, x: piece.x + dx })) return false;
      piece.x += dx;
      touchLock(state, p);
      return true;
    }
    case 'rot': {
      if (!SHAPES[piece.k].rotational) return false;
      const nextR = ((piece.r + action.d) % 4 + 4) % 4;
      const kicks = [
        [0, 0],
        [-1, 0],
        [1, 0],
        [-2, 0],
        [2, 0],
        [0, -1],
      ];
      for (const [dx, dy] of kicks) {
        const candidate = { ...piece, r: nextR, x: piece.x + dx, y: piece.y + dy };
        if (!collides(state.board, candidate)) {
          piece.r = nextR;
          piece.x = candidate.x;
          piece.y = candidate.y;
          touchLock(state, p);
          return true;
        }
      }
      return false;
    }
    case 'soft': {
      if (collides(state.board, { ...piece, y: piece.y + 1 })) return false;
      piece.y += 1;
      piece.fallT = 0;
      state.score += 1;
      touchLock(state, p);
      return true;
    }
    case 'hard': {
      let distance = 0;
      while (!collides(state.board, { ...piece, y: piece.y + 1 })) {
        piece.y += 1;
        distance += 1;
      }
      state.score += distance * 2;
      lockPiece(state, p);
      return true;
    }
    default:
      return false;
  }
}

function stepPlayer(state: GameState, p: number): void {
  const runtime = state.players[p];
  const piece = runtime.piece;
  if (!piece) return;

  piece.fallT += 1;
  if (piece.fallT >= gravityTicks(state, p)) {
    piece.fallT = 0;
    if (!collides(state.board, { ...piece, y: piece.y + 1 })) piece.y += 1;
  }

  if (collides(state.board, { ...piece, y: piece.y + 1 })) {
    piece.lockT += 1;
    if (piece.lockT >= LOCK_DELAY_TICKS) lockPiece(state, p);
  } else {
    piece.lockT = 0;
  }
}

function spawnMeteor(state: GameState): void {
  const col = xorshift(state, 0) % COLS;
  const star = state.config.meteor === 'starfall' && xorshift(state, 0) % 100 < STARFALL_CHANCE;
  const top = topOfColumn(state, col);
  const row = top >= ROWS ? ROWS - 1 : Math.min(ROWS - 1, Math.max(0, top));
  state.meteors.push({ col, row, at: state.tick + METEOR_LEAD_TICKS, star });
}

function impactMeteor(state: GameState, meteor: Meteor): void {
  const targets = new Set<number>();
  const add = (x: number, y: number): void => {
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return;
    targets.add(y * COLS + x);
  };
  if (meteor.star) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) add(meteor.col + dx, meteor.row + dy);
  } else {
    add(meteor.col, meteor.row);
    add(meteor.col - 1, meteor.row);
    add(meteor.col + 1, meteor.row);
    add(meteor.col, meteor.row - 1);
    add(meteor.col, meteor.row + 1);
  }
  let removed = 0;
  for (const index of targets) {
    if (!state.board[index]) continue;
    state.board[index] = null;
    removed += 1;
  }
  pruneShells(state);
  pushEvent(state, {
    type: 'meteor',
    col: meteor.col,
    row: meteor.row,
    star: meteor.star,
    n: removed,
  });
}

function tickMeteors(state: GameState): void {
  if (state.config.meteor === 'off') return;
  if (state.nextMeteorTick === 0) {
    state.nextMeteorTick = state.tick + randRange(state, METEOR_MIN_TICKS, METEOR_MAX_TICKS);
  }
  if (state.tick >= state.nextMeteorTick && state.meteors.length === 0) {
    spawnMeteor(state);
    state.nextMeteorTick = state.tick + randRange(state, METEOR_MIN_TICKS, METEOR_MAX_TICKS);
  }
  if (state.meteors.length === 0) return;
  const falling: Meteor[] = [];
  for (const meteor of state.meteors) {
    if (state.tick >= meteor.at) impactMeteor(state, meteor);
    else falling.push(meteor);
  }
  state.meteors = falling;
}

function chaosInterval(state: GameState): number {
  const range = CHAOS_INTERVAL_TICKS[state.config.chaos === 'frequent' ? 'frequent' : 'occasional'];
  return randRange(state, range[0], range[1]);
}

function tickChaos(state: GameState): void {
  if (state.config.chaos === 'off') return;
  if (state.nextChaosTick === 0) state.nextChaosTick = state.tick + chaosInterval(state);
  const current = state.chaos;
  if (current) {
    if (state.tick < current.end) return;
    state.chaos = null;
    pushEvent(state, { type: 'chaosEnd', kind: current.kind });
    state.nextChaosTick = state.tick + chaosInterval(state);
    return;
  }
  if (state.tick < state.nextChaosTick) return;
  // One event at a time, and never the same one twice in a row: no unfair stacks.
  const pool: ChaosKind[] = (['lowGravity', 'surge', 'blackout', 'colorSurge'] as ChaosKind[]).filter(
    (kind) => kind !== state.lastChaos,
  );
  const kind = pool[xorshift(state, 0) % pool.length] ?? 'colorSurge';
  const start = state.tick + CHAOS_ANNOUNCE_TICKS;
  state.chaos = { kind, start, end: start + CHAOS_DURATION_TICKS[kind] };
  state.lastChaos = kind;
  pushEvent(state, { type: 'chaos', kind });
}

/** A row may have become clearable when its shell expired; give credit to its owner. */
function unlockShellRows(state: GameState): void {
  let full = -1;
  for (let y = 0; y < ROWS && full < 0; y++) {
    let complete = true;
    for (let x = 0; x < COLS; x++) {
      if (!state.board[y * COLS + x]) {
        complete = false;
        break;
      }
    }
    if (complete) full = y;
  }
  if (full < 0) return;
  const tally = [0, 0];
  for (let x = 0; x < COLS; x++) {
    const cell = state.board[full * COLS + x];
    if (cell) tally[cell.p] += 1;
  }
  clearRows(state, tally[1] > tally[0] ? 1 : 0);
}

/** Advance the simulation by exactly one tick. */
export function advance(state: GameState): void {
  if (state.phase === 'won' || state.phase === 'lost') return;
  state.tick += 1;

  if (state.phase === 'countdown') {
    state.phaseTick += 1;
    if (state.phaseTick >= COUNTDOWN_TICKS) {
      state.phase = 'playing';
      state.phaseTick = 0;
      pushEvent(state, { type: 'start' });
    }
    return;
  }

  state.playTicks += 1;
  state.phaseTick += 1;
  if (state.tick > state.comboUntil && state.combo !== 0) state.combo = 0;

  if (state.config.chaos !== 'off') tickChaos(state);
  if (state.config.meteor !== 'off') tickMeteors(state);
  if (state.config.meldMeter) {
    const max = meterMaxTicks(state);
    for (let p = 0; p < state.meter.length; p++) {
      if (state.meter[p] < max) state.meter[p] += 1;
    }
  }

  if (state.shells.length > 0) {
    const before = state.shells.length;
    pruneShells(state);
    if (state.shells.length !== before && state.phase === 'playing') unlockShellRows(state);
  }

  for (let p = 0; p < state.players.length; p++) {
    if (state.phase !== 'playing') break;
    if (state.mode === 'relay' && state.turn !== p) continue;
    stepPlayer(state, p);
  }
  if (state.mode === 'rift' && state.phase === 'playing' && state.playTicks >= RIFT_WAVES * RIFT_WAVE_TICKS) {
    endMatch(state, 'won');
  }
}

export function cloneState(state: GameState): GameState {
  return structuredClone(state);
}

/** Stable checksum used by tests to prove the simulation is deterministic. */
export function stateHash(state: GameState): string {
  let hash = 0x811c9dc5;
  const feed = (value: number) => {
    hash ^= value & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (const cell of state.board) feed(cell ? 1 + cell.p * 8 + cell.k : 0);
  for (const runtime of state.players) {
    const piece = runtime.piece;
    feed(runtime.cells & 0xff);
    feed(runtime.clears & 0xff);
    if (piece) {
      feed(piece.k);
      feed(piece.r);
      feed(piece.x + 8);
      feed(piece.y + 8);
    } else {
      feed(255);
    }
    for (const kind of runtime.next) feed(kind + 16);
  }
  for (const shell of state.shells) feed(shell.i + 32);
  feed(state.combo);
  feed(state.meter.reduce((sum, value) => sum + value, 0) & 0xff);
  feed(state.attack.reduce((sum, value) => sum + value, 0) & 0xff);
  feed(state.score & 0xff);
  feed((state.score >> 8) & 0xff);
  feed((state.score >> 16) & 0xff);
  feed(state.lines);
  feed(state.melds);
  feed(state.phase === 'playing' ? 1 : state.phase === 'won' ? 2 : state.phase === 'lost' ? 3 : 0);
  feed(state.tick & 0xff);
  return hash.toString(16).padStart(8, '0');
}

const CELL_CHARS = '0123456';
const CELL_CHARS_P1 = 'abcdefg';

export function encodeBoard(board: (Cell | null)[]): string {
  const rows: string[] = [];
  for (let y = 0; y < ROWS; y++) {
    let row = '';
    for (let x = 0; x < COLS; x++) {
      const cell = board[y * COLS + x];
      row += cell ? (cell.p === 0 ? CELL_CHARS[cell.k] : CELL_CHARS_P1[cell.k]) : '.';
    }
    rows.push(row);
  }
  return rows.join('/');
}

export function decodeBoard(encoded: string): (Cell | null)[] {
  const rows = encoded.split('/');
  const board: (Cell | null)[] = new Array(ROWS * COLS).fill(null);
  for (let y = 0; y < Math.min(ROWS, rows.length); y++) {
    const row = rows[y];
    for (let x = 0; x < Math.min(COLS, row.length); x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      const p0 = CELL_CHARS.indexOf(ch);
      const p1 = CELL_CHARS_P1.indexOf(ch);
      const k = p0 >= 0 ? p0 : p1;
      if (k < 0) continue;
      board[y * COLS + x] = { p: p0 >= 0 ? 0 : 1, k };
    }
  }
  return board;
}

export function toSnapshot(state: GameState, seqs: number[], paused = false, pauseMs = 0): Snapshot {
  return {
    v: 1,
    difficulty: state.difficulty,
    tick: state.tick,
    playTicks: state.playTicks,
    phase: state.phase,
    phaseTick: state.phaseTick,
    board: encodeBoard(state.board),
    score: state.score,
    lines: state.lines,
    melds: state.melds,
    objective: state.objective,
    players: state.players.map((runtime, i) => ({
      piece: runtime.piece
        ? [runtime.piece.k, runtime.piece.r, runtime.piece.x, runtime.piece.y]
        : null,
      next: [...runtime.next],
      cells: runtime.cells,
      rows: runtime.rows,
      melds: runtime.melds,
      clears: runtime.clears,
      seq: seqs[i] ?? 0,
    })),
    events: state.events.slice(-16),
    winner: state.winner,
    turn: state.turn,
    paused,
    pauseMs,
    config: { ...state.config },
    meter: [...state.meter],
    attack: [...state.attack],
    attackCooldown: [...state.attackCooldown],
    surgeUntil: [...state.surgeUntil],
    shells: state.shells.map((shell) => ({ ...shell })),
    meteors: state.meteors.map((meteor) => ({ ...meteor })),
    nextMeteorTick: state.nextMeteorTick,
    chaos: state.chaos ? { ...state.chaos } : null,
    nextChaosTick: state.nextChaosTick,
    lastChaos: state.lastChaos,
    combo: state.combo,
    comboUntil: state.comboUntil,
  };
}

export function snapshotToState(snapshot: Snapshot, mode: GameMode): GameState {
  const count = snapshot.players.length;
  const config = normalizeConfig(mode, snapshot.config);
  const state: GameState = {
    mode,
    difficulty: snapshot.difficulty ?? 'normal',
    tick: snapshot.tick,
    playTicks: snapshot.playTicks,
    phase: snapshot.phase,
    phaseTick: snapshot.phaseTick,
    board: decodeBoard(snapshot.board),
    players: snapshot.players.map((player) => ({
      piece: player.piece
        ? { k: player.piece[0], r: player.piece[1], x: player.piece[2], y: player.piece[3], fallT: 0, lockT: 0, resets: 0 }
        : null,
      next: [...player.next],
      cells: player.cells,
      rows: player.rows,
      melds: player.melds,
      clears: player.clears ?? 0,
      lastPingTick: -PING_COOLDOWN_TICKS,
    })),
    rng: new Array(count).fill(0x1234567),
    bags: new Array(count).fill(null).map(() => []),
    score: snapshot.score,
    lines: snapshot.lines,
    melds: snapshot.melds,
    objective: snapshot.objective,
    winner: snapshot.winner ?? null,
    turn: snapshot.turn ?? 0,
    config,
    meter: snapshot.meter ? [...snapshot.meter] : new Array(count).fill(0),
    attack: snapshot.attack ? [...snapshot.attack] : new Array(count).fill(0),
    attackCooldown: snapshot.attackCooldown ? [...snapshot.attackCooldown] : new Array(count).fill(0),
    surgeUntil: snapshot.surgeUntil ? [...snapshot.surgeUntil] : new Array(count).fill(0),
    shells: (snapshot.shells ?? []).map((shell) => ({ ...shell })),
    meteors: (snapshot.meteors ?? []).map((meteor) => ({ ...meteor })),
    nextMeteorTick: snapshot.nextMeteorTick ?? 0,
    chaos: snapshot.chaos ? { ...snapshot.chaos } : null,
    nextChaosTick: snapshot.nextChaosTick ?? 0,
    lastChaos: snapshot.lastChaos ?? null,
    combo: snapshot.combo ?? 0,
    comboUntil: snapshot.comboUntil ?? 0,
    events: snapshot.events,
    eventSeq: snapshot.events.reduce((max, event) => Math.max(max, event.id), 0),
  };
  return state;
}
