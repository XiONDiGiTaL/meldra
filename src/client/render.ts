import { COLS, ROWS } from '../shared/constants.js';
import { pieceCells } from '../shared/pieces.js';
import { paletteById } from './palettes.js';
import type { EffectsLevel } from './settings.js';
import type { Cell, CellShell, ChaosState, GameEvent, Meteor, Piece, Phase } from '../shared/types.js';

export interface RenderPlayer {
  name: string;
  paletteId: string;
  connected: boolean;
}

export interface RenderView {
  board: (Cell | null)[];
  pieces: (Piece | null)[];
  phase: Phase;
  countdown: number;
  melds: number;
  objective: number;
  score: number;
  lines: number;
  players: RenderPlayer[];
  next: number[][];
  localPlayer: number;
  events: GameEvent[];
  paused: boolean;
  shells?: CellShell[];
  meteors?: Meteor[];
  chaos?: ChaosState | null;
  chaosActive?: boolean;
  combo?: number;
}

interface Flash {
  rows: number[];
  start: number;
  owner: number;
  combo: number;
}

interface Ping {
  col: number;
  owner: number;
  start: number;
}

interface Burst {
  start: number;
  owner: number;
  combo: number;
  kind: 'meld' | 'meter' | 'meteor' | 'win' | 'lose';
  x?: number;
  y?: number;
}

interface Fragment {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
  color: string;
  size: number;
  spin: number;
  angle: number;
}

interface MeteorMark {
  seen: number;
}

const CLEAR_FLASH_MS = 420;
const PING_MS = 2600;
const BURST_MS = 680;
const METER_WAVE_MS = 1150;
const METEOR_FALL_MS = 900;
const MAX_FRAGMENTS = 260;

function rgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mix(hex: string, target: string, amount: number): string {
  const parse = (value: string) => {
    const clean = value.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16));
  };
  const a = parse(hex);
  const b = parse(target);
  const out = a.map((v, i) => Math.round(v + (b[i] - v) * amount));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/** A tiny icon per piece kind so blocks differ by shape as well as colour. */
function drawKindGlyph(
  ctx: CanvasRenderingContext2D,
  kind: number,
  cx: number,
  cy: number,
  size: number,
  alpha: number,
): void {
  const s = size * 0.2;
  ctx.save();
  ctx.strokeStyle = `rgba(6, 12, 22, ${alpha})`;
  ctx.lineWidth = Math.max(1, size * 0.055);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (kind) {
    case 0: // I — bar
      ctx.moveTo(cx - s, cy);
      ctx.lineTo(cx + s, cy);
      break;
    case 1: // O — square
      ctx.rect(cx - s * 0.6, cy - s * 0.6, s * 1.2, s * 1.2);
      break;
    case 2: // T — triangle
      ctx.moveTo(cx - s, cy + s * 0.55);
      ctx.lineTo(cx, cy - s * 0.75);
      ctx.lineTo(cx + s, cy + s * 0.55);
      ctx.closePath();
      break;
    case 3: // S — wave
      ctx.moveTo(cx - s, cy + s * 0.35);
      ctx.lineTo(cx - s * 0.2, cy - s * 0.35);
      ctx.lineTo(cx + s * 0.2, cy + s * 0.35);
      ctx.lineTo(cx + s, cy - s * 0.35);
      break;
    case 4: // Z — mirrored wave
      ctx.moveTo(cx - s, cy - s * 0.35);
      ctx.lineTo(cx - s * 0.2, cy + s * 0.35);
      ctx.lineTo(cx + s * 0.2, cy - s * 0.35);
      ctx.lineTo(cx + s, cy + s * 0.35);
      break;
    case 5: // J — corner
      ctx.moveTo(cx + s, cy - s);
      ctx.lineTo(cx + s, cy + s * 0.6);
      ctx.lineTo(cx - s, cy + s * 0.6);
      break;
    default: // L — mirrored corner
      ctx.moveTo(cx - s, cy - s);
      ctx.lineTo(cx - s, cy + s * 0.6);
      ctx.lineTo(cx + s, cy + s * 0.6);
      break;
  }
  ctx.stroke();
  ctx.restore();
}

interface BlockOptions {
  alpha?: number;
  ghost?: boolean;
  glow?: boolean;
  cache?: boolean;
}

const spriteCache = new Map<string, HTMLCanvasElement>();

function paintBlock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  owner: number,
  kind: number,
  options: BlockOptions = {},
): void {
  const alpha = options.alpha ?? 1;
  const inset = Math.max(1, size * 0.055);
  const bx = x + inset;
  const by = y + inset;
  const bw = size - inset * 2;
  const bh = size - inset * 2;
  const radius = Math.max(2, size * 0.2);

  ctx.save();
  ctx.globalAlpha = alpha;

  if (options.ghost) {
    roundRect(ctx, bx, by, bw, bh, radius);
    ctx.strokeStyle = rgba(color, 0.5);
    ctx.lineWidth = Math.max(1, size * 0.06);
    ctx.setLineDash([Math.max(2, size * 0.16), Math.max(2, size * 0.14)]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    return;
  }

  if (options.glow) {
    ctx.shadowColor = rgba(color, 0.55);
    ctx.shadowBlur = size * 0.55;
    ctx.shadowOffsetY = 0;
  }

  const gradient = ctx.createLinearGradient(bx, by, bx, by + bh);
  gradient.addColorStop(0, mix(color, '#ffffff', 0.24));
  gradient.addColorStop(0.55, color);
  gradient.addColorStop(1, mix(color, '#050914', 0.3));
  roundRect(ctx, bx, by, bw, bh, radius);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.shadowBlur = 0;

  // Owner cue 0: bright rim plus a corner dot.
  // Owner cue 1: soft rim plus a diagonal weave and a corner ring.
  if (owner === 0) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.62)';
    ctx.lineWidth = Math.max(1, size * 0.055);
    roundRect(ctx, bx, by, bw, bh, radius);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(bx + bw * 0.2, by + bh * 0.2, Math.max(1.2, size * 0.065), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.fill();
  } else {
    ctx.save();
    roundRect(ctx, bx, by, bw, bh, radius);
    ctx.clip();
    ctx.strokeStyle = 'rgba(8, 14, 26, 0.22)';
    ctx.lineWidth = Math.max(1, size * 0.1);
    const step = Math.max(4, size * 0.28);
    for (let offset = -size; offset < size * 2; offset += step) {
      ctx.beginPath();
      ctx.moveTo(bx + offset, by + bh);
      ctx.lineTo(bx + offset + bh, by);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
    ctx.lineWidth = Math.max(1, size * 0.04);
    roundRect(ctx, bx, by, bw, bh, radius);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(bx + bw * 0.22, by + bh * 0.22, Math.max(1.2, size * 0.08), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = Math.max(1, size * 0.05);
    ctx.stroke();
  }

  drawKindGlyph(ctx, kind, bx + bw / 2, by + bh / 2, size, 0.34);
  ctx.restore();
}

/**
 * Board cells are drawn through a sprite cache: the gradients, weave and glyph are painted
 * once per palette/kind/owner/size and then blitted, which keeps phones at full frame rate.
 */
function drawBlock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  owner: number,
  kind: number,
  options: BlockOptions = {},
): void {
  const canCache = options.cache && typeof document !== 'undefined' && size >= 6;
  if (!canCache) {
    paintBlock(ctx, x, y, size, color, owner, kind, options);
    return;
  }

  const px = Math.round(size);
  const key = `${color}|${owner}|${kind}|${px}|${options.ghost ? 1 : 0}`;
  let sprite = spriteCache.get(key);
  if (!sprite) {
    sprite = document.createElement('canvas');
    sprite.width = px;
    sprite.height = px;
    const spriteCtx = sprite.getContext('2d');
    if (!spriteCtx) {
      paintBlock(ctx, x, y, size, color, owner, kind, options);
      return;
    }
    paintBlock(spriteCtx, 0, 0, px, color, owner, kind, { ghost: options.ghost });
    if (spriteCache.size > 400) spriteCache.clear();
    spriteCache.set(key, sprite);
  }

  ctx.save();
  ctx.globalAlpha = options.alpha ?? 1;
  if (options.glow) {
    ctx.shadowColor = rgba(color, 0.55);
    ctx.shadowBlur = size * 0.55;
  }
  ctx.drawImage(sprite, Math.round(x), Math.round(y), px, px);
  ctx.restore();
}

/** A removable crystal shell: a faceted plate with cracks that keeps the cell from clearing. */
function drawShellPlate(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  now: number,
  motion: boolean,
): void {
  const inset = Math.max(1, size * 0.055);
  const bx = x + inset;
  const by = y + inset;
  const w = size - inset * 2;
  const h = size - inset * 2;
  const pulse = motion ? 0.55 + Math.sin(now / 320) * 0.16 : 0.6;
  ctx.save();
  const plate = ctx.createLinearGradient(bx, by, bx + w, by + h);
  plate.addColorStop(0, `rgba(214, 232, 255, ${0.24 * pulse + 0.18})`);
  plate.addColorStop(0.5, `rgba(167, 139, 250, ${0.2 * pulse + 0.12})`);
  plate.addColorStop(1, `rgba(236, 254, 255, ${0.22 * pulse + 0.16})`);
  roundRect(ctx, bx, by, w, h, Math.max(2, size * 0.18));
  ctx.fillStyle = plate;
  ctx.fill();
  ctx.strokeStyle = `rgba(226, 232, 255, ${0.5 + pulse * 0.35})`;
  ctx.lineWidth = Math.max(1, size * 0.055);
  ctx.stroke();
  // Facet cracks read as "break me" rather than as a normal block.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.lineWidth = Math.max(1, size * 0.035);
  ctx.beginPath();
  ctx.moveTo(bx + w * 0.5, by + h * 0.14);
  ctx.lineTo(bx + w * 0.4, by + h * 0.5);
  ctx.lineTo(bx + w * 0.62, by + h * 0.86);
  ctx.moveTo(bx + w * 0.4, by + h * 0.5);
  ctx.lineTo(bx + w * 0.14, by + h * 0.62);
  ctx.moveTo(bx + w * 0.62, by + h * 0.86);
  ctx.lineTo(bx + w * 0.86, by + h * 0.72);
  ctx.stroke();
  ctx.restore();
}

function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, inner: number): void {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI / 4) * i - Math.PI / 2;
    const r = i % 2 === 0 ? radius : inner;
    const px = cx + Math.cos(angle) * r;
    const py = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** The meteor itself: a dark crystal cube with a burning star inside. */
function drawMeteorCube(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  now: number,
  star: boolean,
  motion: boolean,
): void {
  const inset = Math.max(1, size * 0.08);
  const bx = x + inset;
  const by = y + inset;
  const w = size - inset * 2;
  const h = size - inset * 2;
  const core = star ? '#ffe9a8' : '#c4b5fd';
  ctx.save();
  const body = ctx.createLinearGradient(bx, by, bx, by + h);
  body.addColorStop(0, '#191426');
  body.addColorStop(0.55, '#0b0a14');
  body.addColorStop(1, '#05040a');
  roundRect(ctx, bx, by, w, h, Math.max(2, size * 0.18));
  ctx.fillStyle = body;
  ctx.fill();
  ctx.strokeStyle = star ? 'rgba(255, 226, 150, 0.85)' : 'rgba(167, 139, 250, 0.8)';
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.stroke();

  const glow = motion ? 0.6 + Math.sin(now / 180) * 0.25 : 0.7;
  ctx.shadowColor = rgba(core, 0.9);
  ctx.shadowBlur = size * 0.5;
  ctx.strokeStyle = rgba(core, 0.95);
  ctx.lineWidth = Math.max(1, size * (star ? 0.075 : 0.055));
  starPath(ctx, bx + w / 2, by + h / 2, size * 0.3, size * 0.1);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = rgba(core, 0.16 * glow);
  ctx.fill();
  ctx.restore();
}

function dangerRows(board: (Cell | null)[]): number {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) if (board[y * COLS + x]) return y + 1;
  }
  return ROWS;
}

export class BoardRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private flashes: Flash[] = [];
  private pings: Ping[] = [];
  private bursts: Burst[] = [];
  private fragments: Fragment[] = [];
  private meteorMarks = new Map<string, MeteorMark>();
  private lastEventId = 0;
  private lastNow = 0;
  private prevDraw = 0;
  reduceMotion = false;
  effects: EffectsLevel = 'full';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable');
    this.ctx = ctx;
  }

  reset(): void {
    this.flashes = [];
    this.pings = [];
    this.bursts = [];
    this.fragments = [];
    this.meteorMarks.clear();
    this.lastEventId = 0;
  }

  /** Only decoration is dropped by the setting; gameplay feedback stays readable. */
  private get decorated(): boolean {
    return this.effects === 'full' && !this.reduceMotion;
  }

  private get essential(): boolean {
    return this.effects !== 'off';
  }

  private spawnFragments(
    x: number,
    y: number,
    color: string,
    count: number,
    spread: number,
    size: number,
  ): void {
    if (!this.decorated) return;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = spread * (0.35 + Math.random());
      this.fragments.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - spread * 0.3,
        life: 0,
        ttl: 520 + Math.random() * 480,
        color,
        size: size * (0.14 + Math.random() * 0.3),
        spin: (Math.random() - 0.5) * 0.3,
        angle: Math.random() * Math.PI,
      });
    }
    if (this.fragments.length > MAX_FRAGMENTS) {
      this.fragments.splice(0, this.fragments.length - MAX_FRAGMENTS);
    }
  }

  private addBurst(kind: Burst['kind'], owner: number, combo: number, x?: number, y?: number): void {
    if (!this.essential) return;
    this.bursts.push({ start: this.lastNow, owner, combo, kind, x, y });
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const width = Math.max(80, Math.round(rect.width));
    const height = Math.max(160, Math.round(rect.height));
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private ingest(
    events: GameEvent[],
    now: number,
    palettes: ReturnType<typeof paletteById>[],
    geo: { cell: number; ox: number; oy: number },
  ): void {
    this.lastNow = now;
    for (const event of events) {
      if (event.id <= this.lastEventId) continue;
      this.lastEventId = event.id;
      const owner = event.p ?? 0;
      const palette = palettes[owner] ?? palettes[0];
      const combo = event.combo ?? 1;
      if (event.type === 'clear') {
        const rows = event.rows ?? [];
        this.flashes.push({ rows, start: now, owner, combo });
        for (const row of rows) {
          if (row < 0 || row >= ROWS) continue;
          for (let x = 0; x < COLS; x += 2) {
            this.spawnFragments(
              geo.ox + (x + Math.random()) * geo.cell,
              geo.oy + (row + 0.5) * geo.cell,
              palette.colors[x % palette.colors.length],
              1 + Math.min(4, combo),
              geo.cell * 2.2,
              geo.cell,
            );
          }
        }
      } else if (event.type === 'meld') {
        this.addBurst('meld', owner, combo, geo.ox + (COLS / 2) * geo.cell, geo.oy + geo.cell * (ROWS / 2));
        for (const row of event.rows ?? []) {
          for (let i = 0; i < 8; i++) {
            this.spawnFragments(
              geo.ox + Math.random() * COLS * geo.cell,
              geo.oy + (row + 0.5) * geo.cell,
              i % 2 === 0 ? palette.colors[i % 7] : palettes[0].colors[(i + 3) % 7],
              2,
              geo.cell * 3.2,
              geo.cell,
            );
          }
        }
      } else if (event.type === 'meter') {
        this.addBurst('meter', owner, 2, geo.ox + (COLS / 2) * geo.cell, geo.oy + (ROWS / 2) * geo.cell);
        for (let i = 0; i < 26; i++) {
          this.spawnFragments(
            geo.ox + Math.random() * COLS * geo.cell,
            geo.oy + Math.random() * ROWS * geo.cell,
            palette.colors[i % palette.colors.length],
            2,
            geo.cell * 3.4,
            geo.cell,
          );
        }
      } else if (event.type === 'meteor' && event.col !== undefined && event.row !== undefined) {
        const cx = geo.ox + (event.col + 0.5) * geo.cell;
        const cy = geo.oy + (event.row + 0.5) * geo.cell;
        this.addBurst('meteor', owner, event.star ? 3 : 1, cx, cy);
        for (let i = 0; i < (event.star ? 20 : 10); i++) {
          this.spawnFragments(
            cx + (Math.random() - 0.5) * geo.cell,
            cy + (Math.random() - 0.5) * geo.cell,
            event.star ? (i % 2 === 0 ? '#ffe9a8' : '#a5f3fc') : palettes[i % 2]?.colors[i % 7] ?? '#c4b5fd',
            2,
            geo.cell * (event.star ? 4.4 : 3),
            geo.cell,
          );
        }
      } else if (event.type === 'ping' && event.col !== undefined) {
        this.pings.push({ col: event.col, owner, start: now });
      } else if (event.type === 'attack') {
        // The victim sees the effect on the board; the sound and toast carry the warning.
        this.addBurst('meteor', event.p ?? 0, 1, geo.ox + geo.cell * (COLS / 2), geo.oy + geo.cell * 4);
      } else if (event.type === 'win' || event.type === 'lose') {
        this.addBurst(event.type, owner, 3, geo.ox + (COLS / 2) * geo.cell, geo.oy + (ROWS / 2) * geo.cell);
        for (let i = 0; i < 30; i++) {
          this.spawnFragments(
            geo.ox + Math.random() * COLS * geo.cell,
            geo.oy + Math.random() * geo.cell * 3,
            palettes[i % palettes.length]?.colors[i % 7] ?? '#a5f3fc',
            1,
            geo.cell * 2.4,
            geo.cell,
          );
        }
      }
    }
    this.flashes = this.flashes.filter((f) => now - f.start < CLEAR_FLASH_MS);
    this.bursts = this.bursts.filter((b) => now - b.start < (b.kind === 'meter' ? METER_WAVE_MS : BURST_MS));
    this.pings = this.pings.filter((p) => now - p.start < PING_MS);
    this.fragments = this.fragments.filter((f) => f.life < f.ttl);
  }

  draw(view: RenderView, now: number): void {
    this.lastNow = now;
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    if (width === 0 || height === 0) return;

    ctx.clearRect(0, 0, width, height);
    const pad = Math.max(4, Math.min(width, height) * 0.012);
    const cell = Math.floor(Math.min((width - pad * 2) / COLS, (height - pad * 2) / ROWS));
    const boardW = cell * COLS;
    const boardH = cell * ROWS;
    const ox = Math.round((width - boardW) / 2);
    const oy = Math.round((height - boardH) / 2);

    const palettes = [
      paletteById(view.players[0]?.paletteId ?? 'aurora'),
      paletteById(view.players[1]?.paletteId ?? 'aurora'),
    ];
    this.ingest(view.events, now, palettes, { cell, ox, oy });

    // Slightly translucent so the aurora reads as light behind the arena, not a wallpaper.
    const bg = ctx.createLinearGradient(0, oy, 0, oy + boardH);
    bg.addColorStop(0, 'rgba(7, 13, 25, 0.90)');
    bg.addColorStop(0.55, 'rgba(6, 11, 21, 0.91)');
    bg.addColorStop(1, 'rgba(4, 7, 14, 0.93)');
    ctx.fillStyle = bg;
    ctx.fillRect(ox, oy, boardW, boardH);

    const glow = ctx.createRadialGradient(
      ox + boardW / 2,
      oy + boardH * 0.12,
      0,
      ox + boardW / 2,
      oy + boardH * 0.12,
      boardH * 0.55,
    );
    glow.addColorStop(0, 'rgba(96, 165, 250, 0.10)');
    glow.addColorStop(1, 'rgba(96, 165, 250, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(ox, oy, boardW, boardH);

    // Grid
    ctx.strokeStyle = 'rgba(148, 180, 255, 0.055)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < COLS; x++) {
      const px = Math.round(ox + x * cell) + 0.5;
      ctx.moveTo(px, oy);
      ctx.lineTo(px, oy + boardH);
    }
    for (let y = 1; y < ROWS; y++) {
      const py = Math.round(oy + y * cell) + 0.5;
      ctx.moveTo(ox, py);
      ctx.lineTo(ox + boardW, py);
    }
    ctx.stroke();

    // Danger band near the top.
    const top = dangerRows(view.board);
    const danger = top <= 6;
    if (danger) {
      const pulse = this.reduceMotion ? 0.5 : 0.4 + Math.sin(now / 260) * 0.2;
      const dangerGrad = ctx.createLinearGradient(0, oy, 0, oy + cell * 5);
      dangerGrad.addColorStop(0, `rgba(251, 113, 133, ${0.18 + pulse * 0.12})`);
      dangerGrad.addColorStop(1, 'rgba(251, 113, 133, 0)');
      ctx.fillStyle = dangerGrad;
      ctx.fillRect(ox, oy, boardW, cell * 5);
    }

    // Blackout dims the arena shell, never the crystals: the board stays readable.
    const chaosKind = view.chaosActive ? view.chaos?.kind : null;
    const blackout = chaosKind === 'blackout';
    const colorSurge = chaosKind === 'colorSurge';
    if (blackout) {
      ctx.fillStyle = 'rgba(2, 4, 10, 0.66)';
      ctx.fillRect(ox, oy, boardW, boardH);
    }

    // Meld-ready hints: rows that need exactly one block.
    if (view.phase === 'playing') {
      const hintAlpha = this.reduceMotion ? 0.5 : 0.38 + Math.sin(now / 420) * 0.18;
      for (let y = 0; y < ROWS; y++) {
        let empty = -1;
        let filled = 0;
        for (let x = 0; x < COLS; x++) {
          if (view.board[y * COLS + x]) filled++;
          else if (empty === -1) empty = x;
          else {
            empty = -2;
            break;
          }
        }
        if (filled === COLS - 1 && empty >= 0) {
          const px = ox + empty * cell + cell * 0.16;
          const py = oy + y * cell + cell * 0.16;
          roundRect(ctx, px, py, cell * 0.68, cell * 0.68, cell * 0.18);
          ctx.strokeStyle = `rgba(252, 211, 77, ${hintAlpha})`;
          ctx.lineWidth = Math.max(1.5, cell * 0.07);
          ctx.setLineDash([cell * 0.15, cell * 0.12]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // Locked cells
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const cellValue = view.board[y * COLS + x];
        if (!cellValue) continue;
        const palette = palettes[cellValue.p] ?? palettes[0];
        const color = palette.colors[cellValue.k % palette.colors.length];
        drawBlock(ctx, ox + x * cell, oy + y * cell, cell, color, cellValue.p, cellValue.k, {
          cache: true,
          glow: colorSurge,
        });
      }
    }

    // Crystal shells sit on top of their cell and block clearing until they expire.
    for (const shell of view.shells ?? []) {
      const sx = shell.i % COLS;
      const sy = Math.floor(shell.i / COLS);
      if (sy < 0 || sy >= ROWS) continue;
      drawShellPlate(ctx, ox + sx * cell, oy + sy * cell, cell, now, this.essential);
    }

    // Meteor Storm: telegraphed landing cells and the burning cube above them.
    const meteors = view.meteors ?? [];
    if (meteors.length > 0) {
      for (const meteor of meteors) {
        const key = `${meteor.col},${meteor.row},${meteor.at}`;
        let mark = this.meteorMarks.get(key);
        if (!mark) {
          mark = { seen: now };
          this.meteorMarks.set(key, mark);
        }
        const progress = Math.max(0, Math.min(1, (now - mark.seen) / METEOR_FALL_MS));
        const targetX = ox + meteor.col * cell;
        const targetY = oy + meteor.row * cell;
        const pulse = this.essential ? 0.45 + Math.sin(now / 180) * 0.25 : 0.5;
        // Telegraph: a dashed column and a landing bracket.
        ctx.save();
        ctx.strokeStyle = meteor.star ? `rgba(255, 226, 150, ${pulse})` : `rgba(196, 181, 253, ${pulse})`;
        ctx.lineWidth = Math.max(1, cell * 0.05);
        ctx.setLineDash([cell * 0.2, cell * 0.16]);
        ctx.beginPath();
        ctx.moveTo(targetX + cell / 2, oy);
        ctx.lineTo(targetX + cell / 2, targetY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeRect(targetX + 1, targetY + 1, cell - 2, cell - 2);
        ctx.restore();

        const fallY = -cell + (targetY + cell) * progress;
        drawMeteorCube(ctx, targetX, fallY, cell, now, meteor.star, this.essential);
      }
      if (this.meteorMarks.size > 24) this.meteorMarks.clear();
    } else if (this.meteorMarks.size > 0) {
      this.meteorMarks.clear();
    }

    // Ghost + active pieces
    if (view.phase === 'playing' || view.phase === 'countdown') {
      for (let p = 0; p < view.pieces.length; p++) {
        const piece = view.pieces[p];
        if (!piece) continue;
        const palette = palettes[p] ?? palettes[0];
        const color = palette.colors[piece.k % palette.colors.length];
        let ghostY = piece.y;
        for (let i = 0; i < ROWS; i++) {
          if (this.blocked(view.board, piece, piece.x, ghostY + 1)) break;
          ghostY += 1;
        }
        if (ghostY !== piece.y) {
          for (const c of pieceCells(piece.k, piece.r, piece.x, ghostY)) {
            if (c.y < 0) continue;
            drawBlock(ctx, ox + c.x * cell, oy + c.y * cell, cell, color, p, piece.k, {
              ghost: true,
              alpha: 0.55,
              cache: true,
            });
          }
        }
        for (const c of pieceCells(piece.k, piece.r, piece.x, piece.y)) {
          if (c.y < 0) continue;
          drawBlock(ctx, ox + c.x * cell, oy + c.y * cell, cell, color, p, piece.k, {
            glow: p === view.localPlayer,
            alpha: 1,
            cache: true,
          });
        }
      }
    }

    // Clear flashes
    for (const flash of this.flashes) {
      const age = (now - flash.start) / CLEAR_FLASH_MS;
      const alpha = Math.max(0, 1 - age);
      for (const row of flash.rows) {
        if (row < 0 || row >= ROWS) continue;
        const grad = ctx.createLinearGradient(ox, 0, ox + boardW, 0);
        grad.addColorStop(0, `rgba(255, 255, 255, ${0.1 * alpha})`);
        grad.addColorStop(0.5, `rgba(255, 255, 255, ${0.5 * alpha})`);
        grad.addColorStop(1, `rgba(255, 255, 255, ${0.1 * alpha})`);
        ctx.fillStyle = grad;
        ctx.fillRect(ox, oy + row * cell, boardW, cell);
      }
    }

    // Energy waves: Melds, Meld Meter, meteors and match endings each get their own shape.
    for (const burst of this.bursts) {
      const duration = burst.kind === 'meter' ? METER_WAVE_MS : burst.kind === 'meteor' ? 760 : BURST_MS;
      const age = Math.max(0, Math.min(1, (now - burst.start) / duration));
      const palette = palettes[burst.owner] ?? palettes[0];
      const partner = palettes[burst.owner === 0 ? 1 : 0] ?? palette;
      const cx = burst.x ?? ox + boardW / 2;
      const cy = burst.y ?? oy + boardH * 0.62;
      if (burst.kind === 'meter') {
        // A board-wide liquid pulse that sweeps from the centre outwards.
        const sweep = ctx.createRadialGradient(cx, cy, 0, cx, cy, boardH * (0.15 + age * 0.9));
        sweep.addColorStop(0, rgba(palette.accent, 0.3 * (1 - age)));
        sweep.addColorStop(0.6, rgba(partner.accent, 0.16 * (1 - age)));
        sweep.addColorStop(1, rgba(palette.accent, 0));
        ctx.fillStyle = sweep;
        ctx.fillRect(ox, oy, boardW, boardH);
        for (let i = 0; i < 3; i++) {
          const ringAge = Math.max(0, Math.min(1, age * 1.4 - i * 0.16));
          if (ringAge <= 0) continue;
          ctx.beginPath();
          ctx.arc(cx, cy, boardH * (0.08 + ringAge * 0.62), 0, Math.PI * 2);
          ctx.strokeStyle = rgba(i % 2 === 0 ? palette.accent : '#e0f2fe', (1 - ringAge) * 0.55);
          ctx.lineWidth = Math.max(2, cell * 0.16 * (1 - ringAge));
          ctx.stroke();
        }
        continue;
      }
      if (burst.kind === 'meteor') {
        ctx.beginPath();
        ctx.arc(cx, cy, cell * (0.4 + age * 3.2), 0, Math.PI * 2);
        ctx.strokeStyle = rgba('#e9d5ff', (1 - age) * 0.8);
        ctx.lineWidth = Math.max(2, cell * 0.14 * (1 - age));
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, cell * (0.2 + age * 1.9), 0, Math.PI * 2);
        ctx.strokeStyle = rgba('#a5f3fc', (1 - age) * 0.6);
        ctx.stroke();
        continue;
      }
      const combo = Math.min(4, burst.combo ?? 1);
      const radius = cell * (1.5 + combo * 0.25 + age * 4.4);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(palette.accent, (1 - age) * (burst.kind === 'meld' ? 0.8 : 0.65));
      ctx.lineWidth = Math.max(2, cell * 0.12 * (1 - age));
      ctx.stroke();
      if (burst.kind === 'meld' || burst.kind === 'win') {
        ctx.beginPath();
        ctx.arc(cx, cy, radius * 0.72, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(partner.accent, (1 - age) * 0.6);
        ctx.lineWidth = Math.max(1.5, cell * 0.08 * (1 - age));
        ctx.stroke();
      }
      if (burst.kind === 'lose' && this.essential) {
        ctx.fillStyle = `rgba(8, 10, 18, ${0.35 * (1 - age)})`;
        ctx.fillRect(ox, oy, boardW, boardH);
      }
    }

    // Crystal fragments from clears, Melds, meteors and the Meld Meter.
    const dt = Math.min(48, Math.max(0, now - (this.prevDraw || now)));
    this.prevDraw = now;
    for (const fragment of this.fragments) {
      fragment.life += dt;
      if (fragment.life >= fragment.ttl) continue;
      fragment.x += (fragment.vx * dt) / 16;
      fragment.y += (fragment.vy * dt) / 16;
      fragment.vy += (0.09 * dt) / 16;
      fragment.angle += fragment.spin;
      const alpha = Math.max(0, 1 - fragment.life / fragment.ttl);
      ctx.save();
      ctx.translate(fragment.x, fragment.y);
      ctx.rotate(fragment.angle);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fragment.color;
      roundRect(ctx, -fragment.size / 2, -fragment.size / 2, fragment.size, fragment.size, fragment.size * 0.3);
      ctx.fill();
      ctx.restore();
    }

    // Ping rings and column highlight
    for (const ping of this.pings) {
      const age = (now - ping.start) / PING_MS;
      const palette = palettes[ping.owner] ?? palettes[0];
      const cx = ox + ping.col * cell + cell / 2;
      const alpha = Math.max(0, 1 - age);
      const colGrad = ctx.createLinearGradient(0, oy, 0, oy + boardH);
      colGrad.addColorStop(0, rgba(palette.accent, 0.16 * alpha));
      colGrad.addColorStop(1, rgba(palette.accent, 0.02 * alpha));
      ctx.fillStyle = colGrad;
      ctx.fillRect(ox + ping.col * cell, oy, cell, boardH);

      const ringAge = Math.min(1, (now - ping.start) / 900);
      if (ringAge < 1 && !this.reduceMotion) {
        ctx.beginPath();
        ctx.arc(cx, oy + boardH * 0.5, cell * (0.7 + ringAge * 3.2), 0, Math.PI * 2);
        ctx.strokeStyle = rgba(palette.accent, (1 - ringAge) * 0.8);
        ctx.lineWidth = Math.max(2, cell * 0.1);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(cx, oy + boardH * 0.5, cell * 0.34, 0, Math.PI * 2);
      ctx.fillStyle = rgba(palette.accent, 0.24 * alpha);
      ctx.fill();
      ctx.strokeStyle = rgba(palette.accent, 0.85 * alpha);
      ctx.lineWidth = Math.max(1.5, cell * 0.06);
      ctx.stroke();
    }

    // Frame
    ctx.strokeStyle = 'rgba(158, 196, 255, 0.16)';
    ctx.lineWidth = Math.max(1, cell * 0.04);
    roundRect(ctx, ox + 0.5, oy + 0.5, boardW - 1, boardH - 1, cell * 0.16);
    ctx.stroke();
  }

  private blocked(board: (Cell | null)[], piece: Piece, x: number, y: number): boolean {
    for (const c of pieceCells(piece.k, piece.r, x, y)) {
      if (c.x < 0 || c.x >= COLS || c.y >= ROWS) return true;
      if (c.y < 0) continue;
      if (board[c.y * COLS + c.x]) return true;
    }
    return false;
  }

  get lastFrame(): number {
    return this.lastNow;
  }
}

function prepare(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  return ctx ? { ctx, w, h } : null;
}

/** Small preview block used by the palette cycler and player cards. */
export function drawPalettePreview(canvas: HTMLCanvasElement, paletteId: string, partnerPaletteId = 'bloom'): void {
  const prepared = prepare(canvas);
  if (!prepared) return;
  const { ctx, w, h } = prepared;
  ctx.clearRect(0, 0, w, h);

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#070d19');
  bg.addColorStop(1, '#04070e');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const palette = paletteById(paletteId);
  const partner = paletteById(partnerPaletteId);
  const cols = 8;
  const cell = Math.min(w / cols, h / 5);
  const ox = (w - cols * cell) / 2;
  const oy = h - cell * 4.4;

  ctx.strokeStyle = 'rgba(148, 180, 255, 0.06)';
  ctx.lineWidth = 1;
  for (let x = 1; x < cols; x++) {
    ctx.beginPath();
    ctx.moveTo(ox + x * cell, 0);
    ctx.lineTo(ox + x * cell, h);
    ctx.stroke();
  }

  // A representative stack: mostly your colours, one row finished by your partner.
  const layout: { x: number; y: number; k: number; p: 0 | 1 }[] = [
    { x: 0, y: 3, k: 2, p: 0 },
    { x: 1, y: 3, k: 2, p: 0 },
    { x: 2, y: 3, k: 0, p: 0 },
    { x: 3, y: 3, k: 0, p: 1 },
    { x: 4, y: 3, k: 5, p: 1 },
    { x: 5, y: 3, k: 3, p: 0 },
    { x: 0, y: 2, k: 6, p: 0 },
    { x: 1, y: 2, k: 1, p: 0 },
    { x: 4, y: 2, k: 4, p: 1 },
    { x: 5, y: 2, k: 4, p: 0 },
    { x: 4, y: 1, k: 2, p: 1 },
  ];
  for (const block of layout) {
    const colors = block.p === 0 ? palette.colors : partner.colors;
    drawBlock(ctx, ox + block.x * cell, oy + block.y * cell, cell, colors[block.k], block.p, block.k);
  }

  // Active piece with a ghost so the preview reads like the real arena.
  const activeKinds = [2, 0];
  const activeX = [2, 6];
  activeKinds.forEach((kind, index) => {
    const x = activeX[index];
    const y = 0.4;
    for (const c of pieceCells(kind, 0, x, y)) {
      drawBlock(ctx, ox + c.x * cell, oy + c.y * cell, cell, palette.colors[kind], 0, kind, {
        glow: index === 0,
      });
    }
  });
  const ghostX = 6;
  for (const c of pieceCells(0, 0, ghostX, 1.9)) {
    drawBlock(ctx, ox + c.x * cell, oy + c.y * cell, cell, palette.colors[0], 0, 0, {
      ghost: true,
      alpha: 0.5,
    });
  }

  ctx.strokeStyle = 'rgba(158, 196, 255, 0.14)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

/** Next-piece tile. */
export function drawNextPiece(canvas: HTMLCanvasElement, kind: number, paletteId: string, owner: number): void {
  const prepared = prepare(canvas);
  if (!prepared) return;
  const { ctx, w, h } = prepared;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(5, 9, 17, 0.7)';
  ctx.fillRect(0, 0, w, h);
  const palette = paletteById(paletteId);
  const cells = pieceCells(kind, 0, 0, 0);
  const maxX = Math.max(...cells.map((c) => c.x)) + 1;
  const maxY = Math.max(...cells.map((c) => c.y)) + 1;
  const cell = Math.min((w - 10) / Math.max(2, maxX), (h - 10) / Math.max(2, maxY), w / 3.4);
  const ox = (w - maxX * cell) / 2;
  const oy = (h - maxY * cell) / 2;
  for (const c of cells) {
    drawBlock(ctx, ox + c.x * cell, oy + c.y * cell, cell, palette.colors[kind], owner, kind);
  }
}

export function drawTinyBlocks(canvas: HTMLCanvasElement, paletteId: string): void {
  const prepared = prepare(canvas);
  if (!prepared) return;
  const { ctx, w, h } = prepared;
  ctx.clearRect(0, 0, w, h);
  const palette = paletteById(paletteId);
  const count = 7;
  const gap = 2;
  const size = Math.min((w - gap * (count - 1)) / count, h);
  for (let i = 0; i < count; i++) {
    drawBlock(ctx, i * (size + gap), (h - size) / 2, size, palette.colors[i], 0, i);
  }
}
