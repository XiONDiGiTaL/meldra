import type { AppApi } from './api.js';
import { applyI18n, getLang, setLang, t } from './i18n.js';
import type { I18nKey } from './i18n.js';
import { loadSettings, saveSettings, type EffectsLevel, type Lang, type Settings } from './settings.js';
import { createGuestRoom, createHostRoom, createSoloRoom } from './net.js';
import type { BaseRoom } from './net.js';
import { isRoomCode, normalizeRoomCode } from '../shared/protocol.js';
import { defaultConfig } from '../shared/config.js';
import { isOnlineMode, isSoloMode } from '../shared/types.js';
import type { GameMode } from '../shared/types.js';
import { controlGuide, el, openModal, toast } from './ui.js';
import { renderHome } from './views/home.js';
import { renderLobby } from './views/lobby.js';
import { renderGame } from './views/game.js';
import { sfx } from './audio.js';
import { music } from './music.js';
import type { AuroraSetting, LobbyTheme } from './soundtrack.js';

type Screen = 'home' | 'lobby' | 'game';
interface ScreenMount {
  node: HTMLElement;
  dispose: () => void;
}

export class App implements AppApi {
  settings: Settings;
  room: BaseRoom | null = null;
  private root: HTMLElement;
  private screen: Screen = 'home';
  private dispose: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.settings = loadSettings();
    this.applyDocumentSettings();
    music.setScene('lobby');
    this.showHome();

    const code = normalizeRoomCode(new URLSearchParams(location.search).get('room') ?? '');
    if (isRoomCode(code)) this.joinRoom(code);
  }

  // ---------- rendering ----------

  private topbar(): HTMLElement {
    const lang = getLang();
    const langButton = (value: Lang, label: string): HTMLButtonElement =>
      el('button', {
        attrs: { type: 'button', 'aria-pressed': String(lang === value), 'data-lang': value },
        text: label,
        on: {
          click: () => {
            if (getLang() === value) return;
            setLang(value);
            this.refresh();
          },
        },
      });

    const musicButton = el('button', {
      class: `icon-btn music-toggle${this.settings.music ? '' : ' off'}`,
      attrs: {
        type: 'button',
        'aria-pressed': String(this.settings.music),
        'aria-label': t('a11y.toggleMusic'),
        title: t('common.music'),
      },
      text: '♫',
      on: {
        click: () => {
          this.updateSettings({ music: !this.settings.music });
          musicButton.setAttribute('aria-pressed', String(this.settings.music));
          musicButton.classList.toggle('off', !this.settings.music);
          toast(t(this.settings.music ? 'toast.musicOn' : 'toast.musicOff'));
        },
      },
    });

    const sound = el('button', {
      class: 'icon-btn',
      attrs: {
        type: 'button',
        'aria-pressed': String(this.settings.sfx),
        'aria-label': t('a11y.toggleSound'),
        title: t('common.sound'),
      },
      text: this.settings.sfx ? '🔊' : '🔇',
      on: {
        click: () => {
          this.updateSettings({ sfx: !this.settings.sfx });
          sound.textContent = this.settings.sfx ? '🔊' : '🔇';
          sound.setAttribute('aria-pressed', String(this.settings.sfx));
          toast(t(this.settings.sfx ? 'toast.soundOn' : 'toast.soundOff'));
        },
      },
    });

    return el(
      'header',
      { class: 'topbar' },
      el(
        'div',
        { class: 'brand' },
        el(
          'div',
          { class: 'brand-mark', attrs: { 'aria-hidden': 'true' } },
          el('i'),
          el('i'),
          el('i'),
          el('i'),
        ),
        el(
          'div',
          {},
          el('div', { class: 'brand-name', text: t('app.title') }),
          el('div', { class: 'brand-tag', text: t('app.tagline') }),
        ),
      ),
      el(
        'div',
        { class: 'chrome-actions' },
        el(
          'div',
          { class: 'seg', attrs: { role: 'group', 'aria-label': t('a11y.language') } },
          langButton('en', 'EN'),
          langButton('tr', 'TR'),
        ),
        musicButton,
        sound,
        el('button', {
          class: 'chip-btn',
          attrs: { type: 'button' },
          text: t('common.help'),
          on: { click: () => this.openHelp() },
        }),
      ),
    );
  }

  private mount(build: () => ScreenMount): void {
    this.dispose?.();
    this.dispose = null;
    const mounted = build();
    this.root.replaceChildren(this.topbar(), mounted.node);
    this.dispose = mounted.dispose;
    applyI18n(this.root);
  }

  private applyDocumentSettings(): void {
    sfx.enabled = this.settings.sfx;
    music.setEnabled(this.settings.music);
    music.setVolume(this.settings.musicVolume);
    music.setLobbyTheme(this.settings.lobbyTheme);
    document.documentElement.classList.toggle('reduce-motion', this.settings.reduceMotion);
    document.documentElement.dataset.aurora = this.settings.aurora;
  }

  refresh(): void {
    if (this.screen === 'game' && this.room) {
      this.showGame();
      return;
    }
    if (this.screen === 'lobby' && this.room) {
      this.showLobby();
      return;
    }
    this.showHome();
  }

  // ---------- navigation ----------

  showHome(): void {
    if (this.room) {
      const room = this.room;
      this.room = null;
      room.leave();
    }
    this.screen = 'home';
    music.setScene('lobby');
    this.mount(() => renderHome(this));
  }

  showLobby(): void {
    if (!this.room) {
      this.showHome();
      return;
    }
    this.screen = 'lobby';
    music.setScene('lobby');
    const room = this.room;
    this.mount(() => renderLobby(this, room));
  }

  showGame(): void {
    if (!this.room) {
      this.showHome();
      return;
    }
    this.screen = 'game';
    const room = this.room;
    music.setScene('game', room.view?.mode ?? room.mode);
    this.mount(() => renderGame(this, room));
  }

  leaveRoom(): void {
    if (this.room) {
      const room = this.room;
      this.room = null;
      this.screen = 'home';
      room.leave();
    }
    music.setScene('lobby');
    this.mount(() => renderHome(this));
  }

  // ---------- settings and identity ----------

  setName(name: string): void {
    this.settings = saveSettings({ name });
    this.room?.setName(name);
  }

  setPalette(id: string): void {
    this.settings = saveSettings({ palette: id });
    this.room?.setPalette(id);
  }

  updateSettings(patch: Partial<Settings>): void {
    this.settings = saveSettings(patch);
    this.applyDocumentSettings();
    const musicButton = this.root.querySelector<HTMLElement>('.music-toggle');
    if (musicButton) {
      musicButton.setAttribute('aria-pressed', String(this.settings.music));
      musicButton.classList.toggle('off', !this.settings.music);
    }
  }

  // ---------- session actions ----------

  private defaultName(): string {
    return this.settings.name.trim() || t('player.default');
  }

  private bindRoom(room: BaseRoom, errorKeyRef: { key: string | null }): void {
    room.on('start', () => this.showGame());
    room.on('lobby', () => {
      if (this.room === room && this.screen === 'game' && !room.view) this.showLobby();
    });
    room.on('error', (key) => {
      errorKeyRef.key = key;
      toast(t(key as I18nKey), 'bad');
    });
    room.on('toast', (key, vars) => toast(t(key as I18nKey, vars), 'good'));
    room.on('closed', (reason) => {
      if (this.room !== room) return;
      this.room = null;
      if (reason === 'leave') return;
      const key = errorKeyRef.key;
      this.mount(() => renderHome(this));
      this.screen = 'home';
      music.setScene('lobby');
      if (key) return;
      const messages: Record<string, I18nKey> = {
        relay: 'errors.relay',
        'not-found': 'errors.roomNotFound',
        'host-left': 'errors.hostLeft',
        'host-left-room': 'errors.hostLeft',
        abandoned: 'game.abandoned',
      };
      const message = messages[reason];
      if (message) toast(t(message), 'warn');
    });
    room.on('abandoned', () => {
      if (this.room !== room) return;
      this.showLobby();
      toast(t('game.abandoned'), 'warn');
    });
  }

  playTogether(mode: GameMode = 'coop'): void {
    if (this.room || !isOnlineMode(mode)) return;
    const name = this.defaultName();
    if (!this.settings.name.trim()) {
      this.settings = saveSettings({ name });
    }
    const errors = { key: null as string | null };
    const room = createHostRoom(
      name,
      this.settings.palette,
      mode,
      this.settings.difficulty,
      defaultConfig(mode),
      (key: string) => {
        errors.key = key;
        toast(t(key as I18nKey), 'bad');
      },
    );
    this.room = room;
    this.bindRoom(room, errors);
    this.showLobby();
  }

  joinRoom(code: string): boolean {
    const normalized = normalizeRoomCode(code);
    if (!isRoomCode(normalized)) {
      toast(t('errors.invalidCode'), 'warn');
      return false;
    }
    if (this.room) {
      const previous = this.room;
      this.room = null;
      previous.leave();
    }
    const name = this.defaultName();
    if (!this.settings.name.trim()) this.settings = saveSettings({ name });
    const errors = { key: null as string | null };
    const room = createGuestRoom(normalized, name, this.settings.palette, (key) => {
      errors.key = key;
      toast(t(key as I18nKey), 'bad');
    });
    this.room = room;
    this.bindRoom(room, errors);
    this.showLobby();
    return true;
  }

  practice(mode: GameMode = 'solo'): void {
    if (this.room) {
      const previous = this.room;
      this.room = null;
      previous.leave();
    }
    const room = createSoloRoom(isSoloMode(mode) ? mode : 'solo', this.settings.difficulty);
    this.room = room;
    const errors = { key: null as string | null };
    this.bindRoom(room, errors);
    this.showGame();
  }

  // ---------- help ----------

  openHelp(): void {
    const body = el('div', { class: 'stack' });
    const addSection = (title: string, text: string): void => {
      body.append(el('h3', { text: title }), el('p', { class: 'small', text }));
    };

    body.append(el('p', { class: 'small', text: t('help.intro') }));
    addSection(t('help.modesTitle'), t('help.modesBody'));
    addSection(t('help.rulesTitle'), t('help.rulesBody'));
    addSection(t('help.difficultyTitle'), t('help.difficultyBody'));
    addSection(t('help.arenaTitle'), t('help.arenaBody'));
    addSection(t('help.meldTitle'), t('help.meldBody'));
    addSection(t('help.dangerTitle'), t('help.dangerBody'));
    addSection(t('help.scoreTitle'), t('help.scoreBody'));
    addSection(t('help.pingTitle'), t('help.pingBody'));
    addSection(t('help.accessTitle'), t('help.accessBody'));
    addSection(t('help.mobileTitle'), t('help.mobileBody'));

    body.append(
      el('div', { class: 'divider' }),
      el('h3', { text: t('controls.title') }),
      el('div', { class: 'field-label', attrs: { style: 'margin:10px 0 6px' }, text: t('controls.keyboard') }),
      controlGuide('keyboard'),
      el('div', { class: 'field-label', attrs: { style: 'margin:14px 0 6px' }, text: t('controls.touch') }),
      controlGuide('touch'),
      el('p', { class: 'tiny faint', text: t('controls.touchHint') }),
      el('div', { class: 'divider' }),
    );

    const settingsRow = el('div', { class: 'btn-row' });

    const toggle = (
      label: string,
      value: boolean,
      onChange: (next: boolean) => void,
      hint?: string,
    ): HTMLElement => {
      let current = value;
      const button = el('button', {
        class: 'btn small',
        attrs: { type: 'button', 'aria-pressed': String(current) },
        text: `${label}: ${t(current ? 'common.on' : 'common.off')}`,
        on: {
          click: () => {
            current = !current;
            button.setAttribute('aria-pressed', String(current));
            button.textContent = `${label}: ${t(current ? 'common.on' : 'common.off')}`;
            onChange(current);
          },
        },
      });
      if (!hint) return button;
      return el(
        'div',
        { class: 'stack', attrs: { style: 'gap:4px' } },
        button,
        el('span', { class: 'tiny faint', text: hint }),
      );
    };

    settingsRow.append(
      toggle(t('help.soundSetting'), this.settings.sfx, (next) => this.updateSettings({ sfx: next })),
      toggle(t('help.motionSetting'), this.settings.reduceMotion, (next) => this.updateSettings({ reduceMotion: next })),
      toggle(t('help.dragSetting'), this.settings.dragToMove, (next) => this.updateSettings({ dragToMove: next }), t('help.dragSettingHint')),
    );

    const field = (label: string, ...content: (Node | string)[]): HTMLElement => {
      const card = el('div', { class: 'setting' }, el('div', { class: 'setting-label', text: label }));
      for (const child of content) card.append(child);
      return card;
    };

    const onOff = (value: boolean, onChange: (next: boolean) => void): HTMLButtonElement => {
      let current = value;
      const button = el('button', {
        class: 'btn small',
        attrs: { type: 'button', 'aria-pressed': String(current) },
        text: t(current ? 'common.on' : 'common.off'),
        on: {
          click: () => {
            current = !current;
            button.setAttribute('aria-pressed', String(current));
            button.textContent = t(current ? 'common.on' : 'common.off');
            onChange(current);
          },
        },
      });
      return button;
    };

    const segmented = <T extends string>(
      label: string,
      options: Array<{ value: T; label: string }>,
      current: T,
      onPick: (value: T) => void,
    ): HTMLElement => {
      const group = el('div', { class: 'seg', attrs: { role: 'group', 'aria-label': label } });
      for (const option of options) {
        const button = el('button', {
          attrs: { type: 'button', 'aria-pressed': String(option.value === current) },
          text: option.label,
          on: {
            click: () => {
              for (const child of group.children) child.setAttribute('aria-pressed', String(child === button));
              onPick(option.value);
            },
          },
        });
        group.append(button);
      }
      return field(label, el('div', { class: 'setting-row' }, group));
    };

    const musicField = field(
      t('help.musicSetting'),
      el(
        'div',
        { class: 'setting-row' },
        onOff(this.settings.music, (next) => this.updateSettings({ music: next })),
        el('span', { class: 'tiny faint', text: t('help.musicHint') }),
      ),
    );

    const volumeOut = el('output', { text: `${Math.round(this.settings.musicVolume * 100)}%` });
    const volumeInput = el('input', {
      class: 'range',
      attrs: {
        type: 'range',
        min: 0,
        max: 100,
        step: 5,
        value: Math.round(this.settings.musicVolume * 100),
        'aria-label': t('help.musicVolume'),
      },
    });
    volumeInput.addEventListener('input', () => {
      const percent = Number(volumeInput.value);
      volumeOut.textContent = `${percent}%`;
      this.updateSettings({ musicVolume: percent / 100 });
    });
    const volumeField = field(
      t('help.musicVolume'),
      el('div', { class: 'setting-row' }, volumeInput, volumeOut),
    );

    const themeField = segmented<LobbyTheme>(
      t('help.lobbyTheme'),
      [
        { value: 'afterHours', label: t('help.lobbyAfterHours') },
        { value: 'pixelated', label: t('help.lobbyPixelated') },
      ],
      this.settings.lobbyTheme,
      (value) => this.updateSettings({ lobbyTheme: value }),
    );

    const auroraField = segmented<AuroraSetting>(
      t('help.aurora'),
      [
        { value: 'off', label: t('help.auroraOff') },
        { value: 'subtle', label: t('help.auroraSubtle') },
        { value: 'enhanced', label: t('help.auroraEnhanced') },
      ],
      this.settings.aurora,
      (value) => this.updateSettings({ aurora: value }),
    );
    auroraField.append(el('span', { class: 'tiny faint', text: t('help.auroraHint') }));

    const effectsField = segmented<EffectsLevel>(
      t('help.effects'),
      [
        { value: 'full', label: t('help.effectsFull') },
        { value: 'reduced', label: t('help.effectsReduced') },
        { value: 'off', label: t('help.effectsOff') },
      ],
      this.settings.effects,
      (value) => this.updateSettings({ effects: value }),
    );
    effectsField.append(el('span', { class: 'tiny faint', text: t('help.effectsHint') }));

    body.append(
      settingsRow,
      el('div', { class: 'divider' }),
      el('h3', { text: t('help.mediaTitle') }),
      el('p', { class: 'small', text: t('help.mediaBody') }),
      el('div', { class: 'settings-grid' }, musicField, volumeField, themeField, auroraField, effectsField),
    );

    openModal({
      title: t('help.title'),
      body,
      actions: [
        el('button', {
          class: 'btn primary',
          attrs: { type: 'button' },
          text: t('help.dismiss'),
          on: {
            click: () => {
              document.querySelector<HTMLElement>('.modal-backdrop .icon-btn')?.click();
            },
          },
        }),
      ],
    });
  }
}
