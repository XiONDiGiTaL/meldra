import type { AppApi } from '../api.js';
import type { BaseRoom } from '../net.js';
import { inviteLink } from '../net.js';
import { t } from '../i18n.js';
import { nextPaletteId, paletteById } from '../palettes.js';
import { drawPalettePreview } from '../render.js';
import { difficultyKey } from '../view.js';
import { controlGuide, copyText, el, isCoarsePointer, pill, toast } from '../ui.js';
import type { LobbyPlayer } from '../../shared/protocol.js';
import { DIFFICULTIES, type Difficulty, type GameMode } from '../../shared/types.js';
import {
  MELD_TARGET_PRESETS,
  VERSUS_TARGET_PRESETS,
  configurableMode,
  type ChaosLevel,
  type MatchConfig,
  type MatchObjective,
  type MeteorMode,
} from '../../shared/config.js';
import { sfx } from '../audio.js';

function modeInfo(mode: GameMode): { label: 'lobby.modeTogether' | 'lobby.modeVersus' | 'lobby.modeRelay' | 'lobby.modeRift'; desc: 'lobby.modeTogetherDesc' | 'lobby.modeVersusDesc' | 'lobby.modeRelayDesc' | 'lobby.modeRiftDesc' } {
  if (mode === 'versus') return { label: 'lobby.modeVersus', desc: 'lobby.modeVersusDesc' };
  if (mode === 'relay') return { label: 'lobby.modeRelay', desc: 'lobby.modeRelayDesc' };
  if (mode === 'rift') return { label: 'lobby.modeRift', desc: 'lobby.modeRiftDesc' };
  return { label: 'lobby.modeTogether', desc: 'lobby.modeTogetherDesc' };
}

function avatarFor(name: string, paletteId: string): HTMLElement {
  const palette = paletteById(paletteId);
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return el('div', {
    class: 'avatar',
    text: initial,
    attrs: {
      style: `background: linear-gradient(135deg, ${palette.colors[0]}, ${palette.colors[2]}); color:#08111f;`,
    },
  });
}

function miniBlocks(paletteId: string): HTMLElement {
  const palette = paletteById(paletteId);
  return el(
    'div',
    { class: 'mini-blocks' },
    ...palette.colors.map((color) => el('i', { attrs: { style: `background:${color}` } })),
  );
}

export function renderLobby(api: AppApi, room: BaseRoom): { node: HTMLElement; dispose: () => void } {
  let paletteId = api.settings.palette;

  const statusDot = el('span', { class: 'dot online' });
  const statusText = el('span', { class: 'small faint' });
  const codeLabel = el('div', { class: 'code', text: room.code });
  const playersGrid = el('div', { class: 'players' });
  const actionArea = el('div', { class: 'stack' });

  const preview = el('canvas');
  const paletteName = el('div', { class: 'palette-name' });
  const swatches = el('div', { class: 'palette-swatches' });

  const draw = (): void => drawPalettePreview(preview, paletteId, partnerPaletteId());

  function partnerPaletteId(): string {
    const other = room.players.find((player) => player.id !== room.selfId);
    return other?.palette ?? 'bloom';
  }

  function paintPalette(): void {
    const palette = paletteById(paletteId);
    paletteName.textContent = t(palette.nameKey);
    swatches.replaceChildren(...palette.colors.map((color) => el('i', { attrs: { style: `background:${color}` } })));
    draw();
  }

  function changePalette(direction: 1 | -1): void {
    paletteId = nextPaletteId(paletteId, direction);
    api.setPalette(paletteId);
    room.setPalette(paletteId);
    paintPalette();
    sfx.ui();
  }

  const nameInput = el('input', {
    class: 'input',
    attrs: {
      type: 'text',
      maxlength: '18',
      placeholder: t('home.namePlaceholder'),
      'aria-label': t('home.nameLabel'),
      autocomplete: 'nickname',
      value: api.settings.name,
    },
    on: {
      input: (event) => {
        const value = (event.target as HTMLInputElement).value;
        api.setName(value);
        room.setName(value);
      },
    },
  });

  const shareCode = el('button', {
    class: 'btn small',
    attrs: { type: 'button' },
    text: t('lobby.copyCode'),
    on: {
      click: async () => {
        const ok = await copyText(room.code);
        toast(t(ok ? 'toast.codeCopied' : 'errors.generic'), ok ? 'good' : 'warn');
      },
    },
  });

  const shareLink = el('button', {
    class: 'btn small',
    attrs: { type: 'button' },
    text: t('lobby.copyInvite'),
    on: {
      click: async () => {
        const ok = await copyText(inviteLink(room.code));
        toast(t(ok ? 'toast.linkCopied' : 'errors.generic'), ok ? 'good' : 'warn');
      },
    },
  });

  const leaveButton = el('button', {
    class: 'btn small ghost',
    attrs: { type: 'button' },
    text: t('lobby.leave'),
    on: { click: () => api.leaveRoom() },
  });

  function playerCard(player: LobbyPlayer): HTMLElement {
    const isMe = player.id === room.selfId;
    const tags = el(
      'div',
      { class: 'player-meta' },
      el('span', { class: `dot ${player.connected ? 'online' : 'offline'}` }),
      el('span', { text: player.connected ? t('common.online') : t('common.offline') }),
      pill(player.host ? t('common.host') : t('common.guest'), player.host ? 'host' : undefined),
      isMe ? pill(t('lobby.you')) : null,
    );
    const foot = el(
      'div',
      { class: 'player-foot' },
      miniBlocks(player.palette),
      player.ready ? pill(t('common.ready'), 'ready') : pill(t('common.notReady')),
    );
    return el(
      'div',
      { class: `player-card ${isMe ? 'you' : ''}` },
      el(
        'div',
        { class: 'player-top' },
        avatarFor(player.name, player.palette),
        el(
          'div',
          { attrs: { style: 'min-width:0' } },
          el('div', { class: 'player-name', text: player.name }),
          tags,
        ),
      ),
      el('div', { class: 'player-meta' }, el('span', { text: t(paletteById(player.palette).nameKey) })),
      foot,
    );
  }

  function emptyCard(): HTMLElement {
    return el(
      'div',
      { class: 'player-card empty' },
      el('div', { class: 'player-name faint', text: t('lobby.emptySlot') }),
      el('p', { class: 'tiny faint', text: t('lobby.emptyHint') }),
    );
  }

  function guestPlayer(): LobbyPlayer | undefined {
    return room.players.find((player) => !player.host);
  }

  // ---------- room rules ----------

  function ruleField(label: string, control: HTMLElement, hint?: string): HTMLElement {
    return el(
      'div',
      { class: 'rule-field' },
      el('span', { class: 'field-label', text: label }),
      control,
      hint ? el('small', { class: 'tiny faint', text: hint }) : null,
    );
  }

  function segControl<T extends string>(
    options: Array<{ value: T; label: string }>,
    value: T,
    disabled: boolean,
    onPick: (value: T) => void,
  ): HTMLElement {
    return el(
      'div',
      { class: 'seg wrap', attrs: { role: 'group' } },
      ...options.map((option) =>
        el('button', {
          attrs: {
            type: 'button',
            'aria-pressed': String(option.value === value),
            disabled,
          },
          text: option.label,
          on: {
            click: () => {
              if (!disabled) onPick(option.value);
            },
          },
        }),
      ),
    );
  }

  function chipRow(
    values: number[],
    current: number,
    disabled: boolean,
    onPick: (value: number) => void,
  ): HTMLElement {
    return el(
      'div',
      { class: 'rule-chips', attrs: { role: 'group' } },
      ...values.map((value) =>
        el('button', {
          class: `rule-chip${value === current ? ' on' : ''}`,
          attrs: { type: 'button', 'aria-pressed': String(value === current), disabled },
          text: String(value),
          on: {
            click: () => {
              if (!disabled) onPick(value);
            },
          },
        }),
      ),
    );
  }

  function rulesPanel(): HTMLElement {
    const isHost = room.role === 'host';
    const locked = !isHost;
    const config = room.config;
    const set = (patch: Partial<MatchConfig>): void => {
      room.setConfig(patch);
      sfx.ui();
    };
    const onOff = (current: boolean, onChange: (next: boolean) => void): HTMLElement =>
      segControl(
        [
          { value: 'off', label: t('common.off') },
          { value: 'on', label: t('common.on') },
        ],
        current ? 'on' : 'off',
        locked,
        (value) => onChange(value === 'on'),
      );

    const children: HTMLElement[] = [
      el('div', { class: 'panel-title' }, el('span', { class: 'label', text: t('rules.title') })),
    ];

    if (room.mode === 'versus') {
      children.push(
        ruleField(
          t('rules.objective'),
          segControl<MatchObjective>(
            [
              { value: 'target', label: t('rules.targetRows') },
              { value: 'sudden', label: t('rules.sudden') },
            ],
            config.objective === 'sudden' ? 'sudden' : 'target',
            locked,
            (objective) => set({ objective }),
          ),
          t('rules.versusObjectiveHint'),
        ),
      );
      if (config.objective !== 'sudden') {
        children.push(
          ruleField(
            t('rules.rowsTarget'),
            chipRow(VERSUS_TARGET_PRESETS, config.target, locked, (target) => set({ target })),
            t('rules.rowsHint'),
          ),
        );
      }
      children.push(
        ruleField(
          t('rules.meter'),
          onOff(config.meldMeter, (meldMeter) => set({ meldMeter })),
          t('rules.meterDuelHint'),
        ),
        ruleField(
          t('rules.clash'),
          onOff(config.clash, (clash) => set({ clash })),
          t('rules.clashHint'),
        ),
      );
    } else {
      children.push(
        ruleField(
          t('rules.objective'),
          segControl<MatchObjective>(
            [
              { value: 'target', label: t('rules.targetMelds') },
              { value: 'endless', label: t('rules.endless') },
            ],
            config.objective === 'endless' ? 'endless' : 'target',
            locked,
            (objective) => set({ objective }),
          ),
          t('rules.objectiveHint'),
        ),
      );
      if (config.objective !== 'endless') {
        children.push(
          ruleField(
            t('rules.meldTarget'),
            chipRow(MELD_TARGET_PRESETS, config.target, locked, (target) => set({ target })),
            t('rules.meldTargetHint'),
          ),
        );
      }
      children.push(
        ruleField(
          t('rules.meter'),
          onOff(config.meldMeter, (meldMeter) => set({ meldMeter })),
          t('rules.meterHint'),
        ),
        ruleField(
          t('rules.meteor'),
          segControl<MeteorMode>(
            [
              { value: 'off', label: t('common.off') },
              { value: 'standard', label: t('rules.meteorStandard') },
              { value: 'starfall', label: t('rules.meteorStarfall') },
            ],
            config.meteor,
            locked,
            (meteor) => set({ meteor }),
          ),
          t('rules.meteorHint'),
        ),
        ruleField(
          t('rules.chaos'),
          segControl<ChaosLevel>(
            [
              { value: 'off', label: t('common.off') },
              { value: 'occasional', label: t('rules.chaosOccasional') },
              { value: 'frequent', label: t('rules.chaosFrequent') },
            ],
            config.chaos,
            locked,
            (chaos) => set({ chaos }),
          ),
          t('rules.chaosHint'),
        ),
      );
    }

    if (!isHost) children.push(el('p', { class: 'tiny faint', text: t('rules.hostOnly') }));
    return el('div', { class: 'panel panel-pad stack rules-card' }, ...children);
  }

  function actionPanel(): HTMLElement {
    const guest = guestPlayer();
    const isHost = room.role === 'host';
    const canStart = Boolean(isHost && guest?.connected && guest?.ready);
    const hint = !guest
      ? t('lobby.needPartner')
      : !guest.ready
        ? t('lobby.partnerNotReady')
        : t('lobby.startHint');

    const info = modeInfo(room.mode);
    const paceValue = el('span', { class: 'pace-value', text: t(difficultyKey(room.difficulty)) });
    const paceControl = isHost
      ? el(
          'div',
          { class: 'seg', attrs: { role: 'group', 'aria-label': t('lobby.difficulty') } },
          ...DIFFICULTIES.map((difficulty: Difficulty) =>
            el('button', {
              attrs: {
                type: 'button',
                'data-lobby-difficulty': difficulty,
                'aria-pressed': String(room.difficulty === difficulty),
              },
              text: t(difficultyKey(difficulty)),
              on: {
                click: () => {
                  api.updateSettings({ difficulty });
                  room.setDifficulty(difficulty);
                  sfx.ui();
                },
              },
            }),
          ),
        )
      : paceValue;
    const children: HTMLElement[] = [
      el(
        'div',
        { class: 'panel-title' },
        el('span', { class: 'label', text: t('lobby.mode') }),
      ),
      el('h3', { text: t(info.label) }),
      el('p', { class: 'small', text: t(info.desc) }),
      el(
        'div',
        { class: 'pace-row' },
        el('span', { class: 'field-label', text: t('lobby.difficulty') }),
        paceControl,
      ),
      el('div', { class: 'divider' }),
    ];

    if (isHost) {
      children.push(
        el('button', {
          class: 'btn primary wide',
          attrs: { type: 'button', disabled: !canStart },
          text: t('lobby.start'),
          on: { click: () => room.start() },
        }),
        el('p', { class: 'tiny faint', attrs: { style: 'margin-top:8px' }, text: hint }),
      );
    } else {
      const me = room.players.find((player) => player.id === room.selfId);
      const ready = Boolean(me?.ready);
      children.push(
        el('button', {
          class: `btn wide ${ready ? '' : 'primary'}`,
          attrs: { type: 'button' },
          text: ready ? t('lobby.unreadyToggle') : t('lobby.readyToggle'),
          on: {
            click: () => {
              room.setReady(!ready);
              sfx.ui();
            },
          },
        }),
        el('p', { class: 'tiny faint', attrs: { style: 'margin-top:8px' }, text: t('lobby.waitingHost') }),
      );
    }
    children.push(el('p', { class: 'tiny faint', text: isHost ? t('lobby.youAreHost') : t('lobby.youAreGuest') }));
    return el('div', { class: 'panel panel-pad stack' }, ...children);
  }

  let lastSignature = '';

  function update(force = false): void {
    const signature = JSON.stringify({
      players: room.players,
      status: room.status,
      self: room.selfId,
      role: room.role,
      difficulty: room.difficulty,
      config: room.config,
    });
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    const online = room.status === 'online';
    statusDot.className = `dot ${online ? 'online' : room.status === 'reconnecting' ? 'warn' : 'offline'}`;
    statusText.textContent = online
      ? t('common.online')
      : room.status === 'reconnecting'
        ? t('common.reconnecting')
        : t('common.connecting');

    codeLabel.textContent = room.code;
    const cards: HTMLElement[] = [playerCard(room.players[0] ?? hostFallback())];
    const guest = guestPlayer();
    cards.push(guest ? playerCard(guest) : emptyCard());
    playersGrid.replaceChildren(...cards);
    const panels: HTMLElement[] = [actionPanel()];
    if (configurableMode(room.mode)) panels.push(rulesPanel());
    actionArea.replaceChildren(...panels);
  }

  function hostFallback(): LobbyPlayer {
    return {
      id: room.selfId,
      name: api.settings.name || t('common.you'),
      palette: paletteId,
      ready: true,
      host: true,
      connected: true,
    };
  }

  const firstTip = el(
    'div',
    { class: 'note', attrs: { style: 'display:flex;flex-direction:column;gap:8px' } },
    el('span', { text: t('lobby.firstTip') }),
    el(
      'div',
      { class: 'btn-row' },
      el('button', {
        class: 'btn small',
        attrs: { type: 'button' },
        text: t('lobby.firstTipCta'),
        on: {
          click: () => {
            api.updateSettings({ seenHelp: true });
            firstTip.remove();
            api.openHelp();
          },
        },
      }),
      el('button', {
        class: 'btn small ghost',
        attrs: { type: 'button', 'aria-label': t('common.close') },
        text: t('common.close'),
        on: {
          click: () => {
            api.updateSettings({ seenHelp: true });
            firstTip.remove();
          },
        },
      }),
    ),
  );
  const showFirstTip = !api.settings.seenHelp && room.mode !== 'versus';

  const roomPanel = el(
    'div',
    { class: 'panel panel-pad stack' },
    el(
      'div',
      { class: 'room-banner' },
      el(
        'div',
        { class: 'room-code' },
        el(
          'div',
          {},
          el('div', { class: 'field-label', text: t('lobby.roomCode') }),
          codeLabel,
        ),
        el('div', {}, shareCode, shareLink),
      ),
      el('div', { class: 'hero-note' }, statusDot, statusText),
    ),
    el('p', { class: 'small faint', text: t('lobby.shareHint') }),
    ...(showFirstTip ? [firstTip] : []),
    el(
      'div',
      {},
      el(
        'div',
        { class: 'panel-title' },
        el('span', { class: 'label', text: t('lobby.players') }),
      ),
      playersGrid,
    ),
  );

  const identity = el(
    'div',
    { class: 'panel panel-pad stack' },
    el('div', { class: 'panel-title' }, el('span', { class: 'label', text: t('home.identity') })),
    el('div', { class: 'field' }, el('label', { text: t('home.nameLabel') }), nameInput),
    el(
      'div',
      { class: 'field' },
      el('div', { class: 'palette-head' }, el('span', { class: 'field-label', text: t('home.paletteLabel') })),
      el(
        'div',
        { class: 'cycler' },
        el('button', {
          class: 'btn',
          attrs: { type: 'button', 'aria-label': t('home.prevPalette') },
          text: '‹',
          on: { click: () => changePalette(-1) },
        }),
        paletteName,
        el('button', {
          class: 'btn',
          attrs: { type: 'button', 'aria-label': t('home.nextPalette') },
          text: '›',
          on: { click: () => changePalette(1) },
        }),
      ),
      swatches,
    ),
    el('div', { class: 'preview-wrap' }, preview),
    el('p', { class: 'tiny faint', text: t('lobby.paletteNote') }),
    el('div', { class: 'divider' }),
    controlGuide(isCoarsePointer() ? 'touch' : 'keyboard'),
    leaveButton,
  );

  const node = el(
    'div',
    { attrs: { style: 'display:contents' } },
    el(
      'div',
      { class: 'screen-title' },
      el(
        'div',
        {},
        el('span', { class: 'eyebrow', text: t('lobby.eyebrow') }),
        el('h1', { text: t('lobby.title'), attrs: { style: 'font-size:clamp(26px,4vw,40px)' } }),
        el('p', { class: 'small', text: t('lobby.subtitle') }),
      ),
      el('button', {
        class: 'btn small ghost',
        attrs: { type: 'button' },
        text: t('common.help'),
        on: { click: () => api.openHelp() },
      }),
    ),
    el(
      'div',
      { class: 'lobby' },
      el('div', { class: 'stack' }, roomPanel, actionArea),
      identity,
    ),
  );

  const offLobby = room.on('lobby', () => update());
  const offStatus = room.on('status', () => update());
  const onResize = (): void => draw();
  window.addEventListener('resize', onResize);

  paintPalette();
  update(true);
  requestAnimationFrame(draw);

  return {
    node,
    dispose: () => {
      offLobby();
      offStatus();
      window.removeEventListener('resize', onResize);
    },
  };
}
