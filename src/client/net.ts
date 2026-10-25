import { ATTACK_COST, COUNTDOWN_TICKS, DISCONNECT_GRACE_MS, PROTOCOL_VERSION, TICK_MS } from '../shared/constants.js';
import { defaultConfig, normalizeConfig, type MatchConfig } from '../shared/config.js';
import {
  advance,
  applyAction,
  createGame,
  meterMaxTicks,
  snapshotToState,
  toSnapshot,
} from '../shared/engine.js';
import { makeRoomCode, normalizeRoomCode, versionMatches } from '../shared/protocol.js';
import type { LobbyPlayer, PeerMsg, RelayServerMsg } from '../shared/protocol.js';
import type { Action, Difficulty, GameMode, GameState } from '../shared/types.js';
import { countdownSeconds, riftWave } from './view.js';
import type { ViewState } from './view.js';
import { loadSettings } from './settings.js';

export type RoomStatus = 'connecting' | 'online' | 'reconnecting' | 'closed';
export type RoomRole = 'host' | 'guest' | 'solo';

export interface RoomHooks {
  lobby: (players: LobbyPlayer[]) => void;
  start: () => void;
  state: (view: ViewState) => void;
  status: (status: RoomStatus) => void;
  error: (key: string) => void;
  closed: (reason: string) => void;
  toast: (key: string, vars?: Record<string, string | number>) => void;
  pause: (info: { ms: number; reason: string } | null) => void;
  abandoned: () => void;
}

type HookName = keyof RoomHooks;

/**
 * Online rooms are host-authoritative. On a static host (GitHub Pages) the two browsers
 * exchange room messages over a Supabase Realtime broadcast channel, which needs no game
 * server and no database. Local development and the e2e suite still use the Node WebSocket
 * relay, because that is the fastest and most private loop while building the game.
 *
 * The Supabase URL and the anon key are publishable client values (the same relay project
 * used by Kanka Kombat); they are not service credentials. Everything that decides a match
 * stays in the host browser.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEFAULT_SUPABASE_URL = 'https://ezwxppiuxbyzmmheckce.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6d3hwcGl1eGJ5em1taGVja2NlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3MjE4MjEsImV4cCI6MjEwMzI5NzgyMX0.fh6AUpeKPDlm4Tr2xXwhf0VdKsRv1A1bZ2s4WFPDMaE';
const SUPABASE_CHANNEL_PREFIX = 'meldra-room-';

export function supabaseConfig(): { url: string; key: string } {
  const env = import.meta.env as Record<string, string | undefined>;
  return {
    url: env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL,
    key: env.VITE_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY,
  };
}

export function usesLocalRelay(): boolean {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  if (explicit) return true;
  try {
    // A manual switch makes the production transport testable from a local static build.
    const forced = new URLSearchParams(location.search).get('net');
    if (forced === 'supabase') return false;
    if (forced === 'ws') return true;
    return LOOPBACK_HOSTS.has(location.hostname);
  } catch {
    return true;
  }
}

export function relayUrl(): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  if (explicit) return explicit;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location.hostname || 'localhost';
  const port = location.port;
  // In Vite development the client (5191) and the relay (8787) run on separate ports.
  if (import.meta.env.DEV && port !== '8787') return `${proto}//${host}:8787/relay`;
  return `${proto}//${location.host}/relay`;
}

function randomId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `p_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function randomToken(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

const TOKEN_PREFIX = 'meldra.room.';

function readRoomToken(code: string): string | null {
  try {
    return sessionStorage.getItem(TOKEN_PREFIX + code);
  } catch {
    return null;
  }
}

function writeRoomToken(code: string, token: string): void {
  try {
    sessionStorage.setItem(TOKEN_PREFIX + code, token);
  } catch {
    /* private mode: reconnection on reload is unavailable */
  }
}

export function inviteLink(code: string): string {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', code);
  return url.toString();
}

interface TransportHooks {
  open: () => void;
  message: (data: PeerMsg, from: string) => void;
  peerLeft: (from: string) => void;
  close: (fatal: boolean) => void;
}

interface RoomTransport {
  readonly kind: 'ws' | 'supabase';
  status: 'connecting' | 'open' | 'closed';
  connect(): void;
  send(data: PeerMsg): void;
  close(): void;
}

class WsRelay implements RoomTransport {
  readonly kind = 'ws' as const;
  private socket: WebSocket | null = null;
  private manuallyClosed = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  status: 'connecting' | 'open' | 'closed' = 'connecting';

  constructor(
    private url: string,
    private room: string,
    private hooks: TransportHooks,
  ) {}

  connect(): void {
    if (this.manuallyClosed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ k: 'join', room: this.room }));
    };
    socket.onmessage = (event) => {
      let parsed: RelayServerMsg;
      try {
        parsed = JSON.parse(String(event.data)) as RelayServerMsg;
      } catch {
        return;
      }
      if (parsed.k === 'ready') {
        this.status = 'open';
        this.attempts = 0;
        this.failures = 0;
        this.hooks.open();
      } else if (parsed.k === 'msg') {
        this.hooks.message(parsed.d, parsed.from);
      } else if (parsed.k === 'peer-left') {
        this.hooks.peerLeft(parsed.id);
      } else if (parsed.k === 'err') {
        this.failures += 4;
        this.hooks.close(true);
        this.close();
      }
    };
    socket.onclose = () => {
      this.socket = null;
      if (this.manuallyClosed) return;
      this.status = 'connecting';
      this.failures += 1;
      if (this.failures >= 4) {
        this.hooks.close(true);
        return;
      }
      this.hooks.close(false);
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      /* onclose follows and schedules the retry */
    };
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.reconnectTimer) return;
    this.attempts += 1;
    const delay = Math.min(5000, 250 * Math.pow(1.7, this.attempts));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(data: PeerMsg): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.status !== 'open') return;
    try {
      socket.send(JSON.stringify({ k: 'msg', d: data }));
    } catch {
      /* the socket will close and reconnect */
    }
  }

  close(): void {
    this.manuallyClosed = true;
    this.status = 'closed';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = null;
  }
}

/**
 * Broadcast relay for static hosting. Supabase Realtime delivers a channel message to
 * every subscriber except the sender, so a two-player room needs no addressing layer.
 * The channel is disposable: nothing about a match is stored server-side.
 */
class SupabaseRelay implements RoomTransport {
  readonly kind = 'supabase' as const;
  status: 'connecting' | 'open' | 'closed' = 'connecting';
  private manuallyClosed = false;
  private client: { removeChannel(channel: unknown): unknown; realtime: { disconnect(): unknown } } | null = null;
  private channel: { state?: string; send(payload: unknown): Promise<unknown>; subscribe(cb: (state: string) => void): unknown } | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private startup: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private room: string,
    private hooks: TransportHooks,
  ) {}

  connect(): void {
    if (this.manuallyClosed) return;
    this.status = 'connecting';
    void this.start();
  }

  private async start(): Promise<void> {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      if (this.manuallyClosed) return;
      const { url, key } = supabaseConfig();
      const client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 40 } },
      });
      this.client = client;
      const channel = client.channel(SUPABASE_CHANNEL_PREFIX + this.room, {
        config: { broadcast: { self: false, ack: false } },
      });
      this.channel = channel;
      channel.on('broadcast', { event: 'm' }, (message: { payload?: unknown }) => {
        const data = message.payload as PeerMsg | undefined;
        if (!data || typeof data !== 'object' || typeof (data as { t?: unknown }).t !== 'string') return;
        this.hooks.message(data, '');
      });

      this.startup = setTimeout(() => {
        if (this.status !== 'open') this.fail(true);
      }, 12_000);

      channel.subscribe((state: string) => {
        if (this.manuallyClosed) return;
        if (state === 'SUBSCRIBED') {
          if (this.startup) clearTimeout(this.startup);
          this.startup = null;
          this.status = 'open';
          this.hooks.open();
        } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
          if (this.status === 'open') {
            this.status = 'connecting';
            this.hooks.close(false);
          }
        }
      });

      // supabase-js rejoins on its own after a transport drop; this notices a channel that
      // stopped rejoining and lets the room's own watchdog show the reconnecting state.
      this.watchdog = setInterval(() => {
        if (this.manuallyClosed) return;
        if (this.status === 'open' && this.channel?.state && this.channel.state !== 'joined') {
          this.status = 'connecting';
          this.hooks.close(false);
        }
      }, 5000);
    } catch {
      this.fail(true);
    }
  }

  private fail(fatal: boolean): void {
    if (this.manuallyClosed) return;
    this.status = 'closed';
    this.hooks.close(fatal);
    this.close();
  }

  send(data: PeerMsg): void {
    const channel = this.channel;
    if (!channel || this.status !== 'open') return;
    void channel.send({ type: 'broadcast', event: 'm', payload: data }).catch(() => {
      /* the next watchdog tick reports the drop */
    });
  }

  close(): void {
    this.manuallyClosed = true;
    this.status = 'closed';
    if (this.startup) clearTimeout(this.startup);
    if (this.watchdog) clearInterval(this.watchdog);
    this.startup = null;
    this.watchdog = null;
    const client = this.client;
    const channel = this.channel;
    this.channel = null;
    this.client = null;
    try {
      if (client && channel) void client.removeChannel(channel);
      client?.realtime.disconnect();
    } catch {
      /* already gone */
    }
  }
}

function createTransport(room: string, hooks: TransportHooks): RoomTransport {
  if (usesLocalRelay()) return new WsRelay(relayUrl(), room, hooks);
  return new SupabaseRelay(room, hooks);
}

export abstract class BaseRoom {
  abstract readonly role: RoomRole;
  readonly selfId = randomId();
  mode: GameMode = 'coop';
  difficulty: Difficulty = 'normal';
  config: MatchConfig = defaultConfig('coop');
  players: LobbyPlayer[] = [];
  status: RoomStatus = 'connecting';
  view: ViewState | null = null;
  code: string;
  localPlayer = 0;
  protected hooks = new Map<HookName, Set<(payload?: never) => void>>();

  constructor(code: string) {
    this.code = normalizeRoomCode(code);
  }

  on<K extends HookName>(event: K, handler: RoomHooks[K]): () => void {
    let set = this.hooks.get(event);
    if (!set) {
      set = new Set();
      this.hooks.set(event, set);
    }
    set.add(handler as (payload?: never) => void);
    return () => set?.delete(handler as (payload?: never) => void);
  }

  protected emit<K extends HookName>(event: K, ...args: Parameters<RoomHooks[K]>): void {
    const set = this.hooks.get(event);
    if (!set) return;
    for (const handler of set) {
      (handler as (...params: Parameters<RoomHooks[K]>) => void)(...args);
    }
  }

  protected setStatus(status: RoomStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  abstract setReady(ready: boolean): void;
  abstract setName(name: string): void;
  abstract setPalette(palette: string): void;
  abstract setDifficulty(difficulty: Difficulty): void;
  abstract setConfig(patch: Partial<MatchConfig>): void;
  abstract start(): void;
  abstract rematch(): void;
  abstract toLobby(): void;
  abstract action(action: Action): void;
  abstract setPaused(paused: boolean): void;
  abstract leave(): void;
}

function buildView(
  state: GameState,
  players: LobbyPlayer[],
  localPlayer: number,
  paused = false,
  pauseMs = 0,): ViewState {
  const meterMax = Math.max(1, meterMaxTicks(state));
  return {
    mode: state.mode,
    difficulty: state.difficulty,
    phase: state.phase,
    countdown: countdownSeconds(state.phase, state.phaseTick, COUNTDOWN_TICKS),
    config: state.config,
    meter: state.meter.map((value) => Math.max(0, Math.min(1, value / meterMax))),
    meterReady: state.meter.map((value) => value >= meterMax),
    attack: [...state.attack],
    attackCost: ATTACK_COST,
    attackCooldown: [...state.attackCooldown],
    meteors: state.meteors.map((meteor) => ({ ...meteor })),
    chaos: state.chaos ? { ...state.chaos } : null,
    chaosActive: Boolean(
      state.chaos && state.tick >= state.chaos.start && state.tick < state.chaos.end,
    ),
    chaosIn: state.chaos ? Math.max(0, (state.chaos.start - state.tick) * TICK_MS) / 1000 : 0,
    chaosLeft: state.chaos ? Math.max(0, (state.chaos.end - state.tick) * TICK_MS) / 1000 : 0,
    shells: state.shells.map((shell) => ({ ...shell })),
    combo: state.combo,
    board: state.board,
    pieces: state.players.map((player) => player.piece),
    next: state.players.map((player) => [...player.next]),
    cells: state.players.map((player) => player.cells),
    rows: state.players.map((player) => player.rows),
    clears: state.players.map((player) => player.clears),
    melds: state.melds,
    objective: state.objective,
    score: state.score,
    lines: state.lines,
    winner: state.winner,
    turn: state.turn,
    wave: riftWave(state.mode, state.playTicks),
    players: state.players.map((_, index) => {
      const metal = players[index];
      return {
        name: metal?.name || (index === 0 ? 'Player 1' : 'Player 2'),
        paletteId: metal?.palette || 'aurora',
        connected: metal?.connected ?? true,
      };
    }),
    events: state.events,
    localPlayer,
    paused,
    pauseMs,
  };
}

export class HostRoom extends BaseRoom {
  readonly role = 'host' as const;
  private relay: RoomTransport;
  private game: GameState | null = null;
  private seqs: number[] = [0, 0];
  private loop: ReturnType<typeof setInterval> | null = null;
  private accumulator = 0;
  private lastFrame = 0;
  private paused = false;
  private pauseReason: 'partner-offline' | 'host-pause' | 'host-tab' | null = null;
  private pauseStart = 0;
  private pauseTimer: ReturnType<typeof setInterval> | null = null;
  private guestToken: string | null = null;
  private tokens = new Map<string, string>();
  private guestConn: string | null = null;
  private snapPhase = 0;
  private lobbyHeartbeat: ReturnType<typeof setInterval> | null = null;
  private lastGuestSeen = 0;
  private selfName: string;

  constructor(
    code: string,
    name: string,
    palette: string,
    mode: GameMode,
    difficulty: Difficulty,
    rules: MatchConfig,
    private onFatal: (key: string) => void,
  ) {
    super(code);
    this.mode = mode;
    this.difficulty = difficulty;
    this.config = normalizeConfig(mode, rules);
    this.selfName = name.trim() || 'Player';
    this.players = [
      { id: this.selfId, name: this.selfName, palette, ready: true, host: true, connected: true },
    ];
    this.localPlayer = 0;
    this.relay = createTransport(this.code, {
      open: () => {
        this.setStatus('online');
        if (!this.game) this.broadcastLobby();
        this.resumeIfReady();
      },
      message: (message, from) => {
        // Supabase has no transport-level peer ids; any inbound room message is the guest.
        if (!from) this.lastGuestSeen = Date.now();
        this.handlePeer(message, from);
      },
      peerLeft: (from) => this.handlePeerLeft(from),
      close: (fatal) => {
        if (fatal) {
          this.setStatus('closed');
          this.onFatal('errors.relay');
          this.emit('closed', 'relay');
        } else {
          this.setStatus('reconnecting');
          if (this.game && (this.game.phase === 'playing' || this.game.phase === 'countdown')) {
            this.paused = true;
            this.pauseStart = Date.now();
            this.emit('pause', { ms: DISCONNECT_GRACE_MS, reason: 'host-tab' });
            this.startPauseTimer();
          }
        }
      },
    });
    this.relay.connect();
    this.lobbyHeartbeat = setInterval(() => {
      if (this.status !== 'online') return;
      if (!this.game) this.broadcastLobby();
      // A broadcast join has no close event: a silent guest is detected by the missing
      // heartbeat, then handled exactly like a dropped WebSocket.
      const guest = this.guest;
      if (guest?.connected && this.lastGuestSeen && Date.now() - this.lastGuestSeen > 9000) {
        this.handlePeerLeft(this.guestConn ?? '');
      }
    }, 2000);
    this.emit('lobby', this.players);
  }

  private get guest(): LobbyPlayer | undefined {
    return this.players.find((player) => !player.host);
  }

  private broadcastLobby(): void {
    this.relay.send({
      t: 'lobby',
      players: this.players,
      mode: this.mode,
      difficulty: this.difficulty,
      config: this.config,
    });
    this.emit('lobby', this.players);
  }

  private broadcastSnapshot(): void {
    if (!this.game) return;
    const pauseMs = this.paused ? Math.max(0, DISCONNECT_GRACE_MS - (Date.now() - this.pauseStart)) : 0;
    this.view = buildView(this.game, this.players, 0, this.paused, pauseMs);
    this.emit('state', this.view);
    // The guest interpolates between snapshots, so 20 Hz is smooth and leaves the relay
    // plenty of headroom for the guest's own input messages.
    this.snapPhase = (this.snapPhase + 1) % 3;
    const finished = this.game.phase === 'won' || this.game.phase === 'lost';
    if (this.snapPhase === 0 || finished) {
      this.relay.send({ t: 'snap', snap: toSnapshot(this.game, this.seqs, this.paused, pauseMs) });
    }
  }

  private handlePeer(message: PeerMsg, from: string): void {
    switch (message.t) {
      case 'hello': {
        if (!versionMatches(message.v)) {
          this.relay.send({ t: 'err', code: 'errors.version' });
          return;
        }
        const existingByToken = message.token
          ? this.players.find((player) => !player.host && this.tokens.get(player.id) === message.token)
          : undefined;
        const existing = existingByToken ?? this.players.find((player) => !player.host && player.id === message.pid);
        if (existing) {
          existing.id = message.pid;
          existing.name = message.name?.slice(0, 18) || existing.name;
          existing.palette = message.palette || existing.palette;
          existing.connected = true;
          if (message.token) this.tokens.set(message.pid, message.token);
          else if (this.guestToken) this.tokens.set(message.pid, this.guestToken);
          this.guestConn = from;
          this.lastGuestSeen = Date.now();
          this.sendWelcome(existing, message.pid);
          this.broadcastLobby();
          if (this.game) this.broadcastSnapshot();
          this.resumeIfReady();
          return;
        }
        if (this.players.length >= 2) {
          this.relay.send({ t: 'err', code: 'errors.roomFull' });
          return;
        }
        const guest: LobbyPlayer = {
          id: message.pid,
          name: (message.name || 'Partner').slice(0, 18),
          palette: message.palette || 'bloom',
          ready: false,
          host: false,
          connected: true,
        };
        this.guestToken = message.token || randomToken();
        this.tokens.set(guest.id, this.guestToken);
        this.guestConn = from;
        this.lastGuestSeen = Date.now();
        this.players.push(guest);
        this.sendWelcome(guest, message.pid);
        this.broadcastLobby();
        this.emit('toast', 'toast.partnerJoined', { name: guest.name });
        return;
      }
      case 'set': {
        const guest = this.guest;
        if (!guest || (this.guestConn && from !== this.guestConn)) return;
        if (message.name !== undefined) guest.name = message.name.slice(0, 18) || guest.name;
        if (message.palette !== undefined) guest.palette = message.palette;
        if (message.ready !== undefined && !this.game) guest.ready = message.ready;
        this.broadcastLobby();
        return;
      }
      case 'act': {
        if (!this.game || this.game.phase !== 'playing') return;
        if (!this.guest || (this.guestConn && from !== this.guestConn)) return;
        applyAction(this.game, 1, message.a);
        this.seqs[1] = Math.max(this.seqs[1], message.s);
        this.broadcastSnapshot();
        return;
      }
      case 'rematch': {
        if (!this.game) return;
        this.startMatch();
        return;
      }
      case 'pause': {
        if (!this.game) return;
        this.setPaused(message.on);
        return;
      }
      case 'toLobby': {
        if (!this.game) return;
        this.toLobby();
        return;
      }
      case 'ping': {
        this.lastGuestSeen = Date.now();
        return;
      }
      case 'bye': {
        this.removeGuest('partner-left');
        return;
      }
      default:
        return;
    }
  }

  private sendWelcome(player: LobbyPlayer, pid: string): void {
    const token = this.tokens.get(pid) ?? randomToken();
    this.tokens.set(pid, token);
    this.relay.send({
      t: 'welcome',
      pid,
      you: player.id,
      token,
      room: this.code,
      mode: this.mode,
      difficulty: this.difficulty,
      config: this.config,
      players: this.players,
    });
  }

  private handlePeerLeft(from: string): void {
    if (this.guestConn && from !== this.guestConn) return;
    const guest = this.guest;
    if (!guest || !guest.connected) return;
    guest.connected = false;
    this.broadcastLobby();
    if (!this.paused && this.game && (this.game.phase === 'playing' || this.game.phase === 'countdown')) {
      this.paused = true;
      this.pauseReason = 'partner-offline';
      this.pauseStart = Date.now();
      this.relay.send({
        t: 'paused',
        ms: DISCONNECT_GRACE_MS,
        reason: 'partner-offline',
      });
      this.emit('pause', { ms: DISCONNECT_GRACE_MS, reason: 'partner-offline' });
      this.view = buildView(this.game, this.players, 0, true, DISCONNECT_GRACE_MS);
      this.emit('state', this.view);
      this.startPauseTimer();
    }
  }

  private startPauseTimer(): void {
    if (this.pauseTimer) return;
    this.pauseTimer = setInterval(() => {
      const remaining = Math.max(0, DISCONNECT_GRACE_MS - (Date.now() - this.pauseStart));
      if (this.game) {
        this.view = buildView(this.game, this.players, 0, true, remaining);
        this.emit('state', this.view);
      }
      this.relay.send({ t: 'paused', ms: remaining, reason: 'partner-offline' });
      if (remaining <= 0) {
        this.stopPauseTimer();
        this.game = null;
        this.players = this.players.filter((player) => player.host);
        this.emit('abandoned');
        this.broadcastLobby();
      }
    }, 700);
  }

  private stopPauseTimer(): void {
    if (!this.pauseTimer) return;
    clearInterval(this.pauseTimer);
    this.pauseTimer = null;
  }

  private resumeIfReady(): void {
    const guest = this.guest;
    if (!guest?.connected || !this.paused || this.pauseReason !== 'partner-offline') return;
    this.paused = false;
    this.pauseReason = null;
    this.stopPauseTimer();
    this.relay.send({ t: 'resume' });
    this.emit('pause', null);
    this.lastFrame = performance.now();
    this.accumulator = 0;
  }

  setPaused(paused: boolean): void {
    if (!this.game || this.game.phase === 'won' || this.game.phase === 'lost') return;
    if (paused === this.paused) return;
    if (paused) {
      this.paused = true;
      this.pauseReason = 'host-pause';
      this.pauseStart = Date.now();
      this.relay.send({ t: 'paused', ms: 0, reason: 'host-pause' });
      this.emit('pause', { ms: 0, reason: 'host-pause' });
    } else {
      if (this.pauseReason === 'partner-offline') return;
      this.paused = false;
      this.pauseReason = null;
      this.relay.send({ t: 'resume' });
      this.emit('pause', null);
      this.lastFrame = performance.now();
      this.accumulator = 0;
    }
  }

  private removeGuest(reason: string): void {
    if (!this.guest) return;
    const name = this.guest.name;
    this.players = this.players.filter((player) => player.host);
    this.guestToken = null;
    this.game = null;
    this.stopPauseTimer();
    this.paused = false;
    this.broadcastLobby();
    this.emit('toast', 'toast.partnerLeft', { name });
    if (reason === 'partner-left') this.emit('abandoned');
  }

  setReady(ready: boolean): void {
    const self = this.players[0];
    if (self) self.ready = ready;
    this.broadcastLobby();
  }

  setName(name: string): void {
    this.selfName = name.slice(0, 18) || this.selfName;
    const self = this.players[0];
    if (self) self.name = this.selfName;
    this.broadcastLobby();
  }

  setPalette(palette: string): void {
    const self = this.players[0];
    if (self) self.palette = palette;
    this.broadcastLobby();
    if (this.game) this.broadcastSnapshot();
  }

  setDifficulty(difficulty: Difficulty): void {
    if (this.game) return;
    this.difficulty = difficulty;
    this.broadcastLobby();
  }

  setConfig(patch: Partial<MatchConfig>): void {
    if (this.game) return;
    this.config = normalizeConfig(this.mode, { ...this.config, ...patch });
    this.broadcastLobby();
  }

  start(): void {
    const guest = this.guest;
    if (!guest || !guest.connected) {
      this.emit('toast', 'errors.startNeedsPartner');
      return;
    }
    if (!guest.ready) {
      this.emit('toast', 'lobby.partnerNotReady');
      return;
    }
    this.startMatch();
  }

  private startMatch(): void {
    if (this.guest) this.guest.ready = false;
    this.view = null;
    this.game = createGame(this.mode, (Math.random() * 0xffffffff) >>> 0, this.difficulty, this.config);
    this.seqs = [0, 0];
    this.paused = false;
    this.pauseReason = null;
    this.stopPauseTimer();
    this.relay.send({ t: 'start' });
    this.broadcastSnapshot();
    this.emit('start');
    this.startLoop();
  }

  private startLoop(): void {
    if (this.loop) return;
    this.lastFrame = performance.now();
    this.accumulator = 0;
    this.loop = setInterval(() => {
      const game = this.game;
      if (!game) {
        this.stopLoop();
        return;
      }
      const now = performance.now();
      const delta = Math.min(250, now - this.lastFrame);
      this.lastFrame = now;
      if (this.paused) return;
      this.accumulator += delta;
      let steps = 0;
      while (this.accumulator >= TICK_MS && steps < 5) {
        advance(game);
        this.accumulator -= TICK_MS;
        steps += 1;
      }
      if (steps === 0) return;
      this.broadcastSnapshot();
      if (game.phase === 'won' || game.phase === 'lost') {
        this.stopLoop();
      }
    }, 16);
  }

  private stopLoop(): void {
    if (!this.loop) return;
    clearInterval(this.loop);
    this.loop = null;
  }

  rematch(): void {
    if (this.game) this.startMatch();
  }

  toLobby(): void {
    this.game = null;
    this.view = null;
    this.stopLoop();
    this.stopPauseTimer();
    this.paused = false;
    this.pauseReason = null;
    if (this.guest) this.guest.ready = false;
    this.relay.send({ t: 'toLobby' });
    this.broadcastLobby();
    this.emit('lobby', this.players);
  }

  action(action: Action): void {
    if (!this.game || this.game.phase !== 'playing') return;
    this.seqs[0] += 1;
    applyAction(this.game, 0, action);
    this.broadcastSnapshot();
  }

  setLocalPlayerMeta(name: string, palette: string): void {
    this.setName(name);
    this.setPalette(palette);
  }

  leave(): void {
    const relay = this.relay;
    relay.send({ t: 'bye', reason: 'host-left' });
    // Give a broadcast transport a moment to put the farewell on the wire.
    setTimeout(() => relay.close(), 150);
    this.stopLoop();
    this.stopPauseTimer();
    if (this.lobbyHeartbeat) clearInterval(this.lobbyHeartbeat);
    this.lobbyHeartbeat = null;
    this.setStatus('closed');
    this.emit('closed', 'leave');
  }
}

export class GuestRoom extends BaseRoom {
  readonly role = 'guest' as const;
  private relay: RoomTransport;
  private base: GameState | null = null;
  private pending: { s: number; a: Action }[] = [];
  private seq = 0;
  private started = false;
  private token: string | null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private relayReady = false;
  private lastHostMessage = Date.now();
  private paused = false;
  private pauseMs = 0;
  private selfName: string;
  private selfPalette: string;

  constructor(code: string, name: string, palette: string, private onFatal: (key: string) => void) {
    super(code);
    this.selfName = name.trim() || 'Guest';
    this.selfPalette = palette;
    this.localPlayer = 1;
    this.token = readRoomToken(this.code);
    this.players = [];
    this.relay = createTransport(this.code, {
      open: () => {
        this.relayReady = true;
        // The relay is reachable, but the room only exists once the host answers.
        if (this.status !== 'connecting') this.setStatus('reconnecting');
        this.sendHello();
      },
      message: (message) => this.handlePeer(message),
      peerLeft: () => {
        // A guest room has exactly one peer: the host. Treat its departure as a disconnect and
        // let the watchdog either recover on reconnect or report the closed room.
        if (this.status === 'online') this.setStatus('reconnecting');
      },
      close: (fatal) => {
        if (fatal) {
          this.setStatus('closed');
          this.onFatal('errors.relay');
          this.emit('closed', 'relay');
        } else {
          this.setStatus('reconnecting');
        }
      },
    });
    this.relay.connect();
    // A broadcast channel has no backlog: keep introducing ourselves until the host answers,
    // then switch the same timer to a heartbeat so the host can notice a silent guest.
    this.heartbeat = setInterval(() => {
      if (this.status === 'online') this.relay.send({ t: 'ping', ts: Date.now() });
      else this.sendHello();
    }, 2000);
    this.timeout = setTimeout(() => {
      if (this.status !== 'online') {
        this.onFatal(this.relayReady ? 'errors.roomNotFound' : 'errors.relay');
        this.emit('closed', 'not-found');
        this.relay.close();
      }
    }, usesLocalRelay() ? 6000 : 12_000);
    this.watchdog = setInterval(() => {
      if (this.status === 'online' && Date.now() - this.lastHostMessage > 9000) {
        this.setStatus('reconnecting');
      }
      if (this.status === 'reconnecting' && Date.now() - this.lastHostMessage > 22000) {
        this.onFatal('errors.hostLeft');
        this.emit('closed', 'host-left');
        this.relay.close();
      }
    }, 2000);
    this.emit('lobby', this.players);
  }

  private sendHello(): void {
    this.relay.send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      pid: this.selfId,
      token: this.token ?? undefined,
      name: this.selfName,
      palette: this.selfPalette,
    });
  }

  private handlePeer(message: PeerMsg): void {
    this.lastHostMessage = Date.now();
    switch (message.t) {
      case 'welcome': {
        if (this.timeout) {
          clearTimeout(this.timeout);
          this.timeout = null;
        }
        this.lastHostMessage = Date.now();
        this.mode = message.mode;
        this.difficulty = message.difficulty ?? 'normal';
        this.config = normalizeConfig(this.mode, message.config);
        this.token = message.token;
        writeRoomToken(this.code, message.token);
        this.setStatus('online');
        this.players = message.players;
        this.emit('lobby', this.players);
        const current = this.buildGuestView();
        if (current) {
          this.view = current;
          this.emit('state', current);
        }
        return;
      }
      case 'lobby': {
        this.players = message.players;
        this.mode = message.mode;
        this.difficulty = message.difficulty ?? 'normal';
        this.config = normalizeConfig(this.mode, message.config);
        this.emit('lobby', this.players);
        return;
      }
      case 'start': {
        this.base = null;
        this.pending = [];
        this.seq = 0;
        this.started = true;
        this.paused = false;
        this.emit('start');
        return;
      }
      case 'snap': {
        const snapshot = message.snap;
        const acked = snapshot.players[this.localPlayer]?.seq ?? 0;
        this.pending = this.pending.filter((entry) => entry.s > acked);
        const next = snapshotToState(snapshot, this.mode);
        for (const entry of this.pending) applyAction(next, this.localPlayer, entry.a);
        this.base = next;
        this.paused = Boolean(snapshot.paused);
        this.pauseMs = snapshot.pauseMs ?? 0;
        const view = this.buildGuestView();
        if (!view) return;
        this.view = view;
        if (!this.started) {
          this.started = true;
          this.emit('start');
        }
        this.emit('state', view);
        return;
      }
      case 'paused': {
        this.paused = true;
        this.pauseMs = message.ms;
        this.emit('pause', { ms: message.ms, reason: message.reason });
        const view = this.buildGuestView();
        if (view) {
          this.view = view;
          this.emit('state', view);
        }
        return;
      }
      case 'resume': {
        this.paused = false;
        this.pauseMs = 0;
        this.emit('pause', null);
        return;
      }
      case 'toLobby': {
        this.base = null;
        this.started = false;
        this.pending = [];
        this.view = null;
        this.paused = false;
        this.emit('lobby', this.players);
        return;
      }
      case 'bye': {
        this.stopTimers();
        this.emit('closed', message.reason);
        this.relay.close();
        return;
      }
      case 'err': {
        this.stopTimers();
        this.onFatal(message.code);
        this.emit('closed', message.code);
        this.relay.close();
        return;
      }
      default:
        return;
    }
  }

  private buildGuestView(): ViewState | null {
    if (!this.base) return null;
    return buildView(this.base, this.players, this.localPlayer, this.paused, this.pauseMs);
  }

  setReady(ready: boolean): void {
    this.relay.send({ t: 'set', ready });
    const self = this.players.find((player) => !player.host);
    if (self) self.ready = ready;
    this.emit('lobby', this.players);
  }

  setName(name: string): void {
    this.selfName = name.slice(0, 18) || this.selfName;
    this.relay.send({ t: 'set', name: this.selfName });
  }

  setPalette(palette: string): void {
    this.selfPalette = palette;
    this.relay.send({ t: 'set', palette });
  }

  setDifficulty(): void {
    // The host owns the shared pace; a guest sees it in the lobby instead.
  }

  setConfig(): void {
    // Room rules are host-owned; the guest displays the values it receives.
  }

  start(): void {
    this.emit('toast', 'lobby.waitingHost');
  }

  setPaused(paused: boolean): void {
    this.relay.send({ t: 'pause', on: paused });
  }

  rematch(): void {
    this.relay.send({ t: 'rematch' });
  }

  toLobby(): void {
    this.base = null;
    this.started = false;
    this.pending = [];
    this.view = null;
    this.paused = false;
    this.relay.send({ t: 'toLobby' });
    this.emit('lobby', this.players);
  }

  action(action: Action): void {
    if (!this.base || this.base.phase !== 'playing') return;
    this.seq += 1;
    const ok = applyAction(this.base, this.localPlayer, action);
    if (ok) this.pending.push({ s: this.seq, a: action });
    this.relay.send({ t: 'act', s: this.seq, a: action });
    const view = this.buildGuestView();
    if (view) this.view = view;
    if (view) this.emit('state', view);
  }

  private stopTimers(): void {
    if (this.timeout) clearTimeout(this.timeout);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timeout = null;
    this.watchdog = null;
    this.heartbeat = null;
  }

  leave(): void {
    const relay = this.relay;
    relay.send({ t: 'bye', reason: 'guest-left' });
    setTimeout(() => relay.close(), 150);
    this.stopTimers();
    this.setStatus('closed');
    this.emit('closed', 'leave');
  }
}

export class SoloRoom extends BaseRoom {
  readonly role = 'solo' as const;
  private game: GameState;
  private loop: ReturnType<typeof setInterval> | null = null;
  private accumulator = 0;
  private lastFrame = 0;
  private paused = false;
  private seq = 0;
  override code = 'SOLO';

  constructor(name: string, palette: string, mode: GameMode = 'solo', difficulty: Difficulty = 'normal') {
    super('SOLO');
    this.mode = mode;
    this.difficulty = difficulty;
    this.localPlayer = 0;
    this.players = [
      { id: this.selfId, name, palette, ready: true, host: true, connected: true },
    ];
    this.game = createGame(mode, (Math.random() * 0xffffffff) >>> 0, difficulty);
    this.status = 'online';
    this.emit('start');
    this.broadcast();
    this.startLoop();
  }

  private broadcast(): void {
    const view = buildView(this.game, this.players, 0, this.paused, 0);
    this.view = view;
    this.emit('state', view);
  }

  private startLoop(): void {
    if (this.loop) return;
    this.lastFrame = performance.now();
    this.accumulator = 0;
    this.loop = setInterval(() => {
      if (this.paused) return;
      const now = performance.now();
      const delta = Math.min(250, now - this.lastFrame);
      this.lastFrame = now;
      this.accumulator += delta;
      let steps = 0;
      while (this.accumulator >= TICK_MS && steps < 5) {
        advance(this.game);
        this.accumulator -= TICK_MS;
        steps += 1;
      }
      if (steps === 0) return;
      this.broadcast();
      if (this.game.phase === 'won' || this.game.phase === 'lost') this.stopLoop();
    }, 16);
  }

  private stopLoop(): void {
    if (!this.loop) return;
    clearInterval(this.loop);
    this.loop = null;
  }

  setReady(): void {}
  setName(name: string): void {
    if (this.players[0]) this.players[0].name = name;
    this.broadcast();
  }
  setPalette(palette: string): void {
    if (this.players[0]) this.players[0].palette = palette;
    this.broadcast();
  }
  start(): void {
    this.rematch();
  }
  rematch(): void {
    this.game = createGame(this.mode, (Math.random() * 0xffffffff) >>> 0, this.difficulty);
    this.paused = false;
    this.seq = 0;
    this.broadcast();
    this.startLoop();
  }
  toLobby(): void {
    this.leave();
  }
  action(action: Action): void {
    if (this.game.phase !== 'playing') return;
    this.seq += 1;
    applyAction(this.game, 0, action);
    this.broadcast();
  }
  setDifficulty(): void {
    // A solo room's pace is fixed when the room is created.
  }

  setConfig(): void {
    // Solo modes keep their designed shape; room rules apply to hosted rooms.
  }

  setPaused(paused: boolean): void {
    if (this.game.phase === 'won' || this.game.phase === 'lost') return;
    if (this.paused === paused) return;
    this.paused = paused;
    this.emit('pause', paused ? { ms: 0, reason: 'host-pause' } : null);
    if (!paused) {
      this.lastFrame = performance.now();
      this.accumulator = 0;
    }
    this.broadcast();
  }

  leave(): void {
    this.stopLoop();
    this.setStatus('closed');
    this.emit('closed', 'leave');
  }
}

export function createHostRoom(
  name: string,
  palette: string,
  mode: GameMode,
  difficulty: Difficulty,
  rules: MatchConfig,
  onFatal: (key: string) => void,
  code = makeRoomCode(),
): HostRoom {
  return new HostRoom(code, name, palette, mode, difficulty, rules, onFatal);
}

export function createGuestRoom(
  code: string,
  name: string,
  palette: string,
  onFatal: (key: string) => void,
): GuestRoom {
  return new GuestRoom(normalizeRoomCode(code), name, palette, onFatal);
}

export function createSoloRoom(mode: GameMode = 'solo', difficulty: Difficulty = 'normal'): SoloRoom {
  const settings = loadSettings();
  return new SoloRoom(settings.name || 'Player', settings.palette, mode, difficulty);
}
