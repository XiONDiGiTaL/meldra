import { PROTOCOL_VERSION, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './constants.js';
import type { MatchConfig } from './config.js';
import type { Action, Difficulty, GameMode, Snapshot } from './types.js';

export interface LobbyPlayer {
  id: string;
  name: string;
  palette: string;
  ready: boolean;
  host: boolean;
  connected: boolean;
}

/** Messages exchanged between the host client and guests, relayed verbatim. */
export type PeerMsg =
  | { t: 'hello'; v: number; pid: string; token?: string; name: string; palette: string }
  | {
      t: 'welcome';
      pid: string;
      you: string;
      token: string;
      room: string;
      mode: GameMode;
      difficulty: Difficulty;
      config?: MatchConfig;
      players: LobbyPlayer[];
    }
  | {
      t: 'lobby';
      players: LobbyPlayer[];
      mode: GameMode;
      difficulty: Difficulty;
      config?: MatchConfig;
    }
  | { t: 'set'; name?: string; palette?: string; ready?: boolean }
  | { t: 'start' }
  | { t: 'rematch' }
  | { t: 'toLobby' }
  | { t: 'act'; s: number; a: Action }
  | { t: 'snap'; snap: Snapshot }
  | { t: 'paused'; ms: number; reason: 'partner-offline' | 'host-tab' | 'host-pause' }
  | { t: 'pause'; on: boolean }
  | { t: 'resume' }
  | { t: 'bye'; reason: string }
  | { t: 'err'; code: string; message?: string }
  | { t: 'ping'; ts: number };

export type RelayClientMsg = { k: 'join'; room: string } | { k: 'msg'; d: PeerMsg };

export type RelayServerMsg =
  | { k: 'ready'; id: string; room: string }
  | { k: 'msg'; from: string; d: PeerMsg }
  | { k: 'peer-left'; id: string }
  | { k: 'err'; code: string }
  | { k: 'pong'; ts: number };

export function makeRoomCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/** Accepts lower case, spaces and dashes; every other separator is ignored. */
export function normalizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isRoomCode(input: string): boolean {
  const code = normalizeRoomCode(input);
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

export function versionMatches(value: number): boolean {
  return value === PROTOCOL_VERSION;
}
