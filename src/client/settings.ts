import { isDifficulty, type Difficulty } from '../shared/types.js';
import { clamp01, isAuroraSetting, isLobbyTheme, type AuroraSetting, type LobbyTheme } from './soundtrack.js';

export type Lang = 'en' | 'tr';

/** Visual effect budget. Reduced keeps essential feedback; Off removes decoration. */
export type EffectsLevel = 'full' | 'reduced' | 'off';

export function isEffectsLevel(value: unknown): value is EffectsLevel {
  return value === 'full' || value === 'reduced' || value === 'off';
}

export interface Settings {
  name: string;
  lang: Lang | 'auto';
  palette: string;
  sfx: boolean;
  reduceMotion: boolean;
  dragToMove: boolean;
  /** The one-time lobby explainer has been opened or dismissed. */
  seenHelp: boolean;
  /** Chosen pace for the next match; online guests inherit the host's choice. */
  difficulty: Difficulty;
  /** Music is independent of sound effects: both mute and volume. */
  music: boolean;
  musicVolume: number;
  lobbyTheme: LobbyTheme;
  aurora: AuroraSetting;
  /** Local only: never sent to the other player. */
  effects: EffectsLevel;
}

const KEY = 'meldra.settings.v1';

const DEFAULTS: Settings = {
  name: '',
  lang: 'auto',
  palette: 'aurora',
  sfx: true,
  reduceMotion: false,
  dragToMove: true,
  seenHelp: false,
  difficulty: 'normal',
  music: true,
  musicVolume: 0.65,
  lobbyTheme: 'afterHours',
  aurora: 'subtle',
  effects: 'full',
};

let cache: Settings | null = null;

function storage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    return null;
  }
}

export function loadSettings(): Settings {
  if (cache) return { ...cache };
  const store = storage();
  if (!store) return { ...DEFAULTS };
  try {
    const raw = store.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
    cache = { ...DEFAULTS, ...parsed };
    if (cache.lang !== 'en' && cache.lang !== 'tr') cache.lang = 'auto';
    if (!isDifficulty(cache.difficulty)) cache.difficulty = DEFAULTS.difficulty;
    if (typeof cache.music !== 'boolean') cache.music = DEFAULTS.music;
    cache.musicVolume =
      typeof cache.musicVolume === 'number' && Number.isFinite(cache.musicVolume)
        ? clamp01(cache.musicVolume)
        : DEFAULTS.musicVolume;
    if (!isLobbyTheme(cache.lobbyTheme)) cache.lobbyTheme = DEFAULTS.lobbyTheme;
    if (!isAuroraSetting(cache.aurora)) cache.aurora = DEFAULTS.aurora;
    if (!isEffectsLevel(cache.effects)) cache.effects = DEFAULTS.effects;
    return { ...cache };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch };
  cache = next;
  const store = storage();
  if (store) {
    try {
      store.setItem(KEY, JSON.stringify(next));
    } catch {
      /* quota or private mode: preferences simply do not persist */
    }
  }
  return { ...next };
}

/** Turkish speakers get Turkish on a first visit; the manual choice always wins afterwards. */
export function initialLang(settings: Settings = loadSettings()): Lang {
  if (settings.lang === 'en' || settings.lang === 'tr') return settings.lang;
  try {
    const nav = globalThis.navigator?.language ?? 'en';
    return /^tr\b/i.test(nav) ? 'tr' : 'en';
  } catch {
    return 'en';
  }
}

export function resetSettingsCache(): void {
  cache = null;
}
