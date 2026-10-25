import type { AppApi } from '../api.js';
import type { BaseRoom } from '../net.js';
import { getLang, t } from '../i18n.js';
import { BoardRenderer, drawNextPiece } from '../render.js';
import { el } from '../ui.js';
import { paletteById } from '../palettes.js';
import { encodeBoard } from '../../shared/engine.js';
import { isSoloMode } from '../../shared/types.js';
import type { Action, AttackKind, GameEvent, GameMode } from '../../shared/types.js';
import type { ViewState } from '../view.js';
import { toast } from '../ui.js';
import { chaosKey, difficultyKey } from '../view.js';
import { sfx } from '../audio.js';
import { Aurora } from '../aurora.js';
import { music } from '../music.js';
import { DangerLatch, dangerRows } from '../soundtrack.js';

type OverlayKind = 'none' | 'paused' | 'result' | 'waiting' | 'reconnecting' | 'abandoned';

function formatNumber(value: number): string {
  try {
    return new Intl.NumberFormat(getLang()).format(value);
  } catch {
    return String(value);
  }
}

export function renderGame(api: AppApi, room: BaseRoom): { node: HTMLElement; dispose: () => void } {
  let view: ViewState | null = room.view;
  let pauseInfo: { ms: number; reason: string } | null = view?.paused ? { ms: view.pauseMs, reason: 'host-pause' } : null;
  let overlayKind: OverlayKind | 'none' = 'none';
  let overlayNode: HTMLElement | null = null;
  let lastEventId = 0;
  let eventsPrimed = false;
  let lastNextKey = '';
  let lastCountdown = -1;
  let raf = 0;
  let disposed = false;

  const boardWrap = el('div', { class: 'board-wrap' });
  const aurora = new Aurora(boardWrap);
  aurora.setLevel(api.settings.aurora);
  aurora.setReduceMotion(api.settings.reduceMotion);
  const dangerLatch = new DangerLatch();
  const canvas = el('canvas', {
    attrs: { id: 'board', role: 'img', 'aria-label': t('a11y.board'), tabindex: '-1' },
  });
  const countdownNode = el('div', { class: 'countdown' });
  const overlaySlot = el('div');
  boardWrap.append(canvas, countdownNode, overlaySlot);

  const scoreValue = el('div', { class: 'v', text: '0' });
  const meldValue = el('div', { class: 'v', text: '0' });
  const linesValue = el('div', { class: 'v', text: '0' });
  const goalValue = el('div', {
    class: 'v',
    attrs: { style: 'font-size:13px;font-weight:600;line-height:1.4' },
    text: '—',
  });
  const paceValue = el('div', { class: 'v', text: t(difficultyKey(room.difficulty)) });

  function goalText(mode: GameMode, current: ViewState): string {
    if (mode === 'versus') {
      return current.objective > 0 ? t('game.versusGoal', { n: current.objective }) : t('game.suddenGoal');
    }
    if (mode === 'relay') return t('game.relayGoal', { n: current.objective });
    if (mode === 'rift') return t('game.riftWave', { n: current.wave, m: current.objective });
    if (mode === 'architect') return t('game.architectGoal', { n: current.objective });
    if (mode === 'endless') return t('game.endlessGoal');
    if (mode === 'solo') return t('game.soloGoal', { n: current.objective });
    return current.objective > 0
      ? t('game.coopGoal', { n: current.objective })
      : t('game.endlessGoal');
  }
  const oath = el('div', { class: 'oath' });

  function stat(label: string, value: HTMLElement, extra?: HTMLElement): HTMLElement {
    return el('div', { class: 'stat' }, el('div', { class: 'k', text: label }), value, extra ?? null);
  }

  const meterFill = el('i', { class: 'meter-fill' });
  const meterLabel = el('span', { class: 'meter-label', text: t('game.meldMeter') });
  const meterHint = el('small', { class: 'meter-hint', text: t('game.meterHint') });
  const meterNode = el(
    'button',
    {
      class: 'meld-meter',
      attrs: { type: 'button', 'aria-label': t('game.meterAria') },
      on: {
        click: () => {
          if (!view?.meterReady[view.localPlayer]) return;
          sfx.unlock();
          send({ t: 'meter' });
        },
      },
    },
    meterFill,
    el('span', { class: 'meter-text' }, meterLabel, meterHint),
  );

  const chaosText = el('span', { class: 'badge-text' });
  const chaosBadge = el(
    'div',
    { class: 'arena-badge chaos' },
    el('i', { class: 'badge-glyph', text: '✦' }),
    chaosText,
  );
  const comboText = el('span', { class: 'badge-text' });
  const comboBadge = el(
    'div',
    { class: 'arena-badge combo' },
    el('i', { class: 'badge-glyph', text: '✧' }),
    comboText,
  );
  const statusStrip = el('div', { class: 'arena-status' }, chaosBadge, comboBadge);

  const scoreStat = stat(t('game.score'), scoreValue);
  const meldLabel = el('div', { class: 'k', text: t('game.melds') });
  const meldStat = el('div', { class: 'stat' }, meldLabel, meldValue, oath);
  const linesStat = stat(t('game.lines'), linesValue);
  const goalStat = stat(t('game.goal'), goalValue);
  const paceStat = stat(t('game.pace'), paceValue);

  const pauseButton = el('button', {
    class: 'btn small wide',
    attrs: { type: 'button' },
    text: t('game.pause'),
    on: { click: () => togglePause() },
  });
  const helpButton = el('button', {
    class: 'btn small wide ghost',
    attrs: { type: 'button' },
    text: t('common.help'),
    on: { click: () => api.openHelp() },
  });

  const controlsCard = el(
    'div',
    { class: 'game-help' },
    el('b', { text: t('controls.title') }),
    el(
      'div',
      {},
      keyHint(t('controls.moveKeys'), t('controls.move')),
      keyHint(t('controls.rotateKeys'), t('controls.rotate')),
      keyHint(t('controls.hardKeys'), t('controls.hard')),
      keyHint(t('controls.pingKeys'), t('controls.ping')),
    ),
    el('span', { text: t('controls.repeat') }),
  );

  function keyHint(keys: string, label: string): HTMLElement {
    return el('div', { attrs: { style: 'margin-top:4px' } }, el('kbd', { text: keys }), ' ', label);
  }

  // ---------- Clash Attack controls (Duel only, host-enabled) ----------

  const clashButtons = new Map<AttackKind, HTMLButtonElement>();
  const clashCharge = el('span', { class: 'tiny faint' });
  const clashNote = el('p', { class: 'tiny faint', text: t('game.clashHint') });
  const clashCard = el('div', { class: 'game-help clash-card' });
  const attackLabels: Record<AttackKind, string> = {
    obstruction: t('game.clashObstruction'),
    surge: t('game.clashSurge'),
    shell: t('game.clashShell'),
  };
  for (const kind of ['obstruction', 'surge', 'shell'] as AttackKind[]) {
    const button = el('button', {
      class: 'btn small wide',
      attrs: { type: 'button' },
      text: attackLabels[kind],
      on: {
        click: () => {
          if (pauseInfo) return;
          sfx.ui();
          send({ t: 'clash', kind });
        },
      },
    });
    clashButtons.set(kind, button);
    clashCard.append(button);
  }
  clashCard.prepend(el('b', { text: t('game.clashTitle') }), clashCharge);
  clashCard.append(clashNote);

  const leftColumn = el(
    'div',
    { class: 'game-left' },
    scoreStat,
    meldStat,
    linesStat,
    goalStat,
    paceStat,
    clashCard,
    pauseButton,
    helpButton,
    controlsCard,
  );

  function playerChip(isLocal: boolean): {
    root: HTMLElement;
    name: HTMLElement;
    bar: HTMLElement;
    nextCanvas: HTMLCanvasElement;
    paletteDot: HTMLElement;
    chipScore: HTMLElement;
  } {
    const name = el('div', { class: 'name', text: isLocal ? t('game.you') : t('game.partner') });
    const chipScore = el('div', { class: 'chip-score' });
    const dot = el('span', { class: 'dot online' });
    const paletteDot = el('i', { attrs: { style: 'width:8px;height:8px;border-radius:2px;display:inline-block' } });
    const bar = el('i');
    const contribution = el('div', { class: 'contribution' }, bar);
    const nextCanvas = el('canvas', { class: 'next-canvas' });
    const root = el(
      'div',
      { class: `player-chip ${isLocal ? 'local' : 'partner'}` },
      el(
        'div',
        { class: 'row' },
        paletteDot,
        name,
        dot,
      ),
      el(
        'div',
        { class: 'next-row' },
        el('span', { class: 'tiny faint', text: t('game.next') }),
        nextCanvas,
      ),
      contribution,
      chipScore,
      el('div', { class: 'tiny faint', text: t('game.contribution') }),
    );
    return { root, name, bar, nextCanvas, paletteDot, chipScore };
  }

  const localChip = playerChip(true);
  const partnerChip = playerChip(false);

  const rightColumn = el(
    'div',
    { class: 'game-right' },
    localChip.root,
    partnerChip.root,
  );

  const boardShell = el('div', { class: 'board-shell' }, meterNode, statusStrip, boardWrap);

  const touchPad = el('div', { class: 'touch' });

  const leftPad = el('div', { class: 'cluster' });
  const rightPad = el('div', { class: 'cluster' });

  function touchButton(glyph: string, label: string, action: Action, repeat: boolean, extraClass = ''): HTMLButtonElement {
    const button = el(
      'button',
      {
        class: extraClass,
        attrs: { type: 'button', 'aria-label': label },
      },
      el('span', { text: glyph }),
      el('small', { text: label }),
    );
    bindHold(button, action, repeat);
    return button;
  }

  leftPad.append(
    touchButton('←', t('controls.touchMove'), { t: 'left' }, true),
    touchButton('→', t('controls.touchMove'), { t: 'right' }, true),
    touchButton('↓', t('controls.touchSoft'), { t: 'soft' }, true),
  );
  rightPad.append(
    touchButton('↻', t('controls.touchRotate'), { t: 'rot', d: 1 }, false),
    touchButton('⤓', t('controls.touchHard'), { t: 'hard' }, false, 'hard'),
    touchButton('◎', t('controls.touchPing'), { t: 'ping' }, false),
  );
  touchPad.append(leftPad, rightPad);
  boardShell.append(touchPad);

  const node = el('div', { class: 'game' }, leftColumn, boardShell, rightColumn);
  document.body.classList.add('playing');

  const renderer = new BoardRenderer(canvas);
  renderer.reduceMotion = api.settings.reduceMotion;
  music.setScene('game', view?.mode ?? room.mode);

  let meterShown = false;

  function fit(): void {
    const wrapWidth = boardWrap.clientWidth;
    if (wrapWidth <= 0) return;
    const narrow = window.innerWidth <= 700;
    // Reserve room for the top bar, compact HUD, player chips, touch pads and the meter strip.
    const reserved = (narrow ? 322 : 250) + (meterShown ? 62 : 0);
    const availableHeight = window.innerHeight - reserved;
    const height = Math.max(220, Math.min(availableHeight, 660, wrapWidth * 2));
    const width = height / 2;
    canvas.style.width = `${Math.round(width)}px`;
    canvas.style.height = `${Math.round(height)}px`;
    aurora.setFrameWidth(width);
    renderer.resize();
  }

  const resizeObserver = new ResizeObserver(() => fit());
  resizeObserver.observe(boardWrap);
  window.addEventListener('resize', fit);
  // A view mounted while the panel is hidden has no layout yet; fit once it settles.
  const firstFit = setTimeout(fit, 120);
  const onVisible = (): void => {
    if (!document.hidden) fit();
  };
  document.addEventListener('visibilitychange', onVisible);

  function send(action: Action): void {
    if (disposed) return;
    if (pauseInfo) return;
    if (view && (view.phase === 'won' || view.phase === 'lost')) return;
    room.action(action);
  }

  function togglePause(): void {
    if (view && (view.phase === 'won' || view.phase === 'lost')) return;
    if (pauseInfo) {
      room.setPaused(false);
    } else {
      room.setPaused(true);
    }
    sfx.ui();
  }

  // ---------- input ----------

  let heldKey: string | null = null;
  let holdDelay: ReturnType<typeof setTimeout> | null = null;
  let holdInterval: ReturnType<typeof setInterval> | null = null;

  function clearHold(): void {
    if (holdDelay) clearTimeout(holdDelay);
    if (holdInterval) clearInterval(holdInterval);
    holdDelay = null;
    holdInterval = null;
    heldKey = null;
  }

  function startHold(key: string, action: Action): void {
    clearHold();
    heldKey = key;
    send(action);
    holdDelay = setTimeout(() => {
      holdInterval = setInterval(() => send(action), 85);
    }, 210);
  }

  const keyActions: Record<string, Action> = {
    ArrowLeft: { t: 'left' },
    a: { t: 'left' },
    A: { t: 'left' },
    ArrowRight: { t: 'right' },
    d: { t: 'right' },
    D: { t: 'right' },
    ArrowUp: { t: 'rot', d: 1 },
    w: { t: 'rot', d: 1 },
    W: { t: 'rot', d: 1 },
    q: { t: 'rot', d: -1 },
    Q: { t: 'rot', d: -1 },
    ArrowDown: { t: 'soft' },
    s: { t: 'soft' },
    S: { t: 'soft' },
    ' ': { t: 'hard' },
    c: { t: 'ping' },
    C: { t: 'ping' },
  };

  const repeatable = new Set(['ArrowLeft', 'a', 'A', 'ArrowRight', 'd', 'D', 'ArrowDown', 's', 'S']);

  function onKeyDown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.querySelector('.modal-backdrop')) return;
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      togglePause();
      return;
    }
    if (event.key === 'h' || event.key === 'H') {
      event.preventDefault();
      api.openHelp();
      return;
    }
    if (event.key === 'm' || event.key === 'M') {
      event.preventDefault();
      if (view?.meterReady[view.localPlayer] && !pauseInfo) send({ t: 'meter' });
      return;
    }
    const action = keyActions[event.key];
    if (!action) return;
    event.preventDefault();
    if (event.repeat) return;
    if (repeatable.has(event.key)) {
      startHold(event.key, action);
    } else {
      send(action);
    }
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (heldKey === event.key) clearHold();
  }

  function onBlur(): void {
    clearHold();
  }

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);

  function bindHold(button: HTMLButtonElement, action: Action, repeat: boolean): void {
    let delay: ReturnType<typeof setTimeout> | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    const stop = (): void => {
      button.classList.remove('pressed');
      if (delay) clearTimeout(delay);
      if (interval) clearInterval(interval);
      delay = null;
      interval = null;
    };
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      button.classList.add('pressed');
      send(action);
      sfx.unlock();
      if (repeat) {
        delay = setTimeout(() => {
          interval = setInterval(() => send(action), 90);
        }, 220);
      }
    });
    button.addEventListener('pointerup', stop);
    button.addEventListener('pointercancel', stop);
    button.addEventListener('pointerleave', stop);
    button.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  // Drag to move: horizontal drags step the piece, downward drags soft drop.
  let dragPointer: number | null = null;
  let lastX = 0;
  let lastY = 0;

  function onPointerDown(event: PointerEvent): void {
    if (!api.settings.dragToMove) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    dragPointer = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* not critical */
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (dragPointer !== event.pointerId) return;
    const cellWidth = canvas.clientWidth / 10;
    if (cellWidth <= 0) return;
    const dx = event.clientX - lastX;
    const step = Math.max(1, cellWidth * 0.82);
    const steps = Math.trunc(dx / step);
    if (steps !== 0) {
      const action: Action = steps < 0 ? { t: 'left' } : { t: 'right' };
      for (let i = 0; i < Math.abs(steps); i++) send(action);
      lastX += steps * step;
    }
    const dy = event.clientY - lastY;
    if (dy > cellWidth * 0.9) {
      send({ t: 'soft' });
      lastY = event.clientY;
    }
  }

  function endDrag(): void {
    dragPointer = null;
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  // ---------- overlays ----------

  function overlayButton(label: string, onClick: () => void, kind = ''): HTMLElement {
    return el('button', {
      class: `btn ${kind}`.trim(),
      attrs: { type: 'button' },
      text: label,
      on: { click: onClick },
    });
  }

  function buildOverlay(kind: OverlayKind): HTMLElement | null {
    const inner = el('div', { class: 'inner' });
    const box = el('div', { class: 'overlay' }, inner);

    if (kind === 'waiting') {
      inner.append(
        el('h2', { text: t('game.connecting') }),
        el('p', { class: 'small', text: t('lobby.connecting') }),
      );
      return box;
    }

    if (kind === 'reconnecting') {
      inner.append(
        el('h2', { text: t('common.reconnecting') }),
        el('p', { class: 'small', text: t('lobby.connectionLost') }),
        overlayButton(t('game.backHome'), () => api.leaveRoom(), 'ghost'),
      );
      return box;
    }

    if (kind === 'abandoned') {
      inner.append(
        el('h2', { text: t('game.abandoned') }),
        el('p', { class: 'small', text: t('game.abandonedDesc') }),
        overlayButton(t('game.backHome'), () => api.leaveRoom(), 'primary'),
      );
      return box;
    }

    if (kind === 'paused') {
      const partnerSlot = view ? 1 - view.localPlayer : 1;
      const partnerName = view?.players[partnerSlot]?.name ?? t('common.partner');
      const isGuest = room.role === 'guest';
      const isSolo = room.role === 'solo';
      const offline = pauseInfo?.reason === 'partner-offline';
      const seconds = pauseInfo ? Math.ceil((pauseInfo.ms ?? 0) / 1000) : 0;
      const detail = offline
        ? t('game.pausedByPartner', { name: partnerName })
        : isGuest
          ? t('game.waitingForHost')
          : t('game.pausedHint');
      if (offline) {
        inner.append(el('h2', { text: t('game.paused') }), el('p', { class: 'small', text: detail }));
        inner.append(el('p', { class: 'small strong', text: t('game.partnerDropped', { s: Math.max(0, seconds) }) }));
      } else {
        inner.append(el('h2', { text: t('game.paused') }), el('p', { class: 'small', text: detail }));
      }
      inner.append(
        el(
          'div',
          { class: 'btn-row', attrs: { style: 'justify-content:center' } },
          overlayButton(t('common.help'), () => api.openHelp()),
          overlayButton(isSolo ? t('game.backHome') : t('game.backToLobby'), () => {
            if (isSolo) api.showHome();
            else room.toLobby();
          }, 'ghost'),
          isGuest
            ? null
            : overlayButton(t('game.resume'), () => room.setPaused(false), 'primary'),
        ),
      );
      return box;
    }

    if (kind === 'result') {
      const won = view?.phase === 'won';
      const mode = view?.mode ?? room.mode;
      const solo = isSoloMode(mode);
      let title: string;
      let desc: string;
      if (mode === 'versus') {
        const localWon = view?.winner === view?.localPlayer;
        title = t(localWon ? 'game.versusWin' : 'game.versusLose');
        desc = t(localWon ? 'game.versusWinDesc' : 'game.versusLoseDesc');
      } else if (mode === 'endless') {
        title = t('game.endlessOver');
        desc = t('game.endlessDesc');
      } else if (mode === 'rift') {
        title = t(won ? 'game.riftWin' : 'game.defeat');
        desc = t(won ? 'game.riftWinDesc' : 'game.riftLoseDesc');
      } else if (solo) {
        title = t(won ? 'game.soloWin' : 'game.soloLose');
        desc = t(won ? 'game.soloWinDesc' : 'game.soloLoseDesc');
      } else {
        title = t(won ? 'game.victory' : 'game.defeat');
        desc = t(won ? 'game.victoryDesc' : 'game.defeatDesc');
      }

      let progress: string;
      if (mode === 'versus') {
        const local = view?.clears[view?.localPlayer ?? 0] ?? 0;
        const rival = view?.clears[(view?.localPlayer ?? 0) === 0 ? 1 : 0] ?? 0;
        progress = `${t('game.you')} ${local} · ${t('game.rival')} ${rival}`;
      } else if (mode === 'rift') {
        progress = `${t('game.riftGoal', { n: view?.objective ?? 0 })} · ${t('game.melds')}: ${view?.melds ?? 0}`;
      } else if (solo) {
        progress = `${t('game.lines')}: ${view?.lines ?? 0}${mode === 'endless' ? '' : `/${view?.objective ?? 0}`}`;
      } else if ((view?.objective ?? 0) <= 0) {
        progress = `${t('game.melds')}: ${view?.melds ?? 0} · ${t('game.lines')}: ${view?.lines ?? 0}`;
      } else {
        progress = `${t('game.melds')}: ${view?.melds ?? 0}/${view?.objective ?? 0} · ${t('game.lines')}: ${view?.lines ?? 0}`;
      }

      inner.append(
        el('h2', { text: title }),
        el('p', { class: 'small', text: desc }),
        el('div', { class: 'divider', attrs: { style: 'width:100%' } }),
        el(
          'div',
          { class: 'hero-note', attrs: { style: 'justify-content:center' } },
          el('span', { class: 'strong', text: `${t('game.score')}: ${formatNumber(view?.score ?? 0)}` }),
          el('span', { class: 'faint', text: '·' }),
          el('span', { class: 'strong', text: progress }),
        ),
        el(
          'div',
          { class: 'btn-row', attrs: { style: 'justify-content:center;width:100%' } },
          overlayButton(t('game.rematch'), () => room.rematch(), 'primary'),
          solo
            ? overlayButton(t('game.backHome'), () => api.showHome(), 'ghost')
            : overlayButton(t('game.backToLobby'), () => room.toLobby(), 'ghost'),
        ),
      );
      return box;
    }

    return null;
  }

  function setOverlay(kind: OverlayKind): void {
    if (kind === overlayKind && overlayNode) return;
    overlayKind = kind;
    overlaySlot.replaceChildren();
    overlayNode = kind === 'none' ? null : buildOverlay(kind);
    if (overlayNode) overlaySlot.append(overlayNode);
  }

  // ---------- rendering ----------

  function pop(text: string): void {
    const existing = boardWrap.querySelector('.score-pop');
    if (existing) existing.remove();
    const node2 = el('div', { class: 'score-pop', text });
    boardWrap.append(node2);
    setTimeout(() => node2.remove(), 1150);
  }

  function reactToEvent(event: GameEvent, current: ViewState): void {
    switch (event.type) {
      case 'lock':
        sfx.lock();
        break;
      case 'clear':
        sfx.clear(Math.min(4, Math.max(event.n ?? 1, event.combo ?? 1)));
        if ((event.combo ?? 0) >= 2) {
          pop(t('game.comboToast', { n: event.combo ?? 0 }));
        } else {
          pop(event.n && event.n > 1 ? t('game.clearToastN', { n: event.n }) : t('game.clearToast'));
        }
        break;
      case 'meld':
        sfx.meld();
        pop(event.n && event.n > 1 ? t('game.meldToastN', { n: event.n }) : t('game.meldToast'));
        break;
      case 'meter':
        sfx.meld();
        pop(t('game.meterUsed'));
        break;
      case 'meteor':
        sfx.clear(event.star ? 3 : 2);
        pop(t(event.star ? 'game.starfallHit' : 'game.meteorHit'));
        break;
      case 'chaos':
        if (
          event.kind === 'lowGravity' ||
          event.kind === 'surge' ||
          event.kind === 'blackout' ||
          event.kind === 'colorSurge'
        ) {
          toast(t('game.chaosAnnounce', { name: t(chaosKey(event.kind)) }), 'warn');
        }
        break;
      case 'attack': {
        const kindName =
          event.kind === 'obstruction'
            ? t('game.clashObstruction')
            : event.kind === 'shell'
              ? t('game.clashShell')
              : t('game.clashSurge');
        if (event.p === current.localPlayer) {
          toast(t('game.attackSentWith', { name: kindName }), 'info');
        } else {
          toast(t('game.attackIncomingWith', { name: kindName }), 'warn');
        }
        break;
      }
      case 'ping': {
        sfx.ping();
        const player = event.p !== undefined ? current.players[event.p] : undefined;
        toast(t('game.pingToast', { name: player?.name ?? t('common.partner'), col: (event.col ?? 0) + 1 }));
        break;
      }
      case 'win':
        sfx.win();
        break;
      case 'lose':
        sfx.lose();
        break;
      default:
        break;
    }
  }

  function processEvents(current: ViewState): void {
    const events = current.events ?? [];
    if (!eventsPrimed) {
      eventsPrimed = true;
      lastEventId = events.reduce((max, event) => Math.max(max, event.id), 0);
      return;
    }
    let maxId = lastEventId;
    for (const event of events) maxId = Math.max(maxId, event.id);
    if (maxId < lastEventId) lastEventId = 0;
    for (const event of events) {
      if (event.id <= lastEventId) continue;
      lastEventId = event.id;
      reactToEvent(event, current);
    }
  }

  function paint(current: ViewState): void {
    const solo = isSoloMode(current.mode);
    const versus = current.mode === 'versus';
    const relay = current.mode === 'relay';
    const rift = current.mode === 'rift';
    const localIndex = current.localPlayer;
    const partnerIndex = solo ? -1 : 1 - localIndex;
    canvas.dataset.phase = current.phase;
    canvas.dataset.board = encodeBoard(current.board);
    canvas.dataset.localPlayer = String(localIndex);
    canvas.dataset.turn = String(current.turn);
    const active = current.pieces[localIndex];
    canvas.dataset.piece = active
      ? [active.k, active.r, active.x, active.y].join(',')
      : '';
    scoreValue.textContent = formatNumber(current.score);
    meldLabel.textContent = solo || versus ? t('game.lines') : t('game.melds');
    if (versus) {
      meldValue.textContent = `${current.clears[localIndex] ?? 0} / ${current.objective}`;
    } else if (solo) {
      meldValue.textContent =
        current.mode === 'endless' ? String(current.lines) : `${current.lines} / ${current.objective}`;
    } else {
      meldValue.textContent =
        current.objective > 0
          ? `${current.melds} / ${current.objective}`
          : `${current.melds} · ${t('game.endless')}`;
    }
    linesStat.style.display = solo || versus ? 'none' : '';
    linesValue.textContent = String(current.lines);
    paceValue.textContent = t(difficultyKey(current.difficulty));

    // ---------- Meld Meter ----------
    const config = current.config;
    const showingMeter = config.meldMeter && (current.mode === 'coop' || versus);
    meterShown = showingMeter;
    meterNode.style.display = showingMeter ? '' : 'none';
    const charge = current.meter[localIndex] ?? 0;
    const ready = Boolean(current.meterReady[localIndex]);
    meterFill.style.width = `${Math.round(Math.max(0, Math.min(1, charge)) * 100)}%`;
    meterNode.classList.toggle('ready', ready);
    meterNode.disabled = !ready || current.phase !== 'playing' || Boolean(pauseInfo);
    meterLabel.textContent = ready ? t('game.meterReady') : t('game.meldMeter');
    meterHint.textContent = ready ? t('game.meterReadyHint') : t('game.meterHint');

    // ---------- Chaos + combo status ----------
    if (current.chaos) {
      const name = t(chaosKey(current.chaos.kind));
      chaosBadge.classList.add('show');
      chaosBadge.classList.toggle('active', current.chaosActive);
      chaosText.textContent = current.chaosActive
        ? t('game.chaosActive', { name, s: Math.max(0, Math.ceil(current.chaosLeft)) })
        : t('game.chaosIncoming', { name, s: Math.max(0, Math.ceil(current.chaosIn)) });
    } else {
      chaosBadge.classList.remove('show');
    }
    if (current.combo >= 2) {
      comboBadge.classList.add('show');
      comboText.textContent = t('game.comboBadge', { n: current.combo });
    } else {
      comboBadge.classList.remove('show');
    }

    // ---------- Clash Attack ----------
    const clashOn = versus && config.clash;
    clashCard.classList.toggle('on', clashOn);
    if (clashOn) {
      const points = current.attack[localIndex] ?? 0;
      clashCharge.textContent = t('game.clashCharge', { n: points, max: current.attackCost });
      const affordable = points >= current.attackCost && current.phase === 'playing' && !pauseInfo;
      for (const button of clashButtons.values()) button.disabled = !affordable;
    }
    if (relay && current.phase === 'playing') {
      goalValue.textContent =
        current.turn === localIndex
          ? t('game.yourTurn')
          : t('game.partnerTurn', { name: current.players[partnerIndex]?.name ?? t('common.partner') });
    } else {
      goalValue.textContent = goalText(current.mode, current);
    }

    const segments =
      current.mode === 'endless' || current.objective <= 0 ? 0 : Math.max(1, current.objective);
    const filled = versus
      ? current.clears[localIndex] ?? 0
      : rift
        ? Math.max(0, current.wave - 1)
        : solo
          ? current.lines
          : current.melds;
    oath.style.display = segments === 0 ? 'none' : '';
    if (oath.children.length !== segments) {
      oath.replaceChildren(...Array.from({ length: segments }, () => el('i')));
    }
    for (let i = 0; i < oath.children.length; i++) {
      const segment = oath.children[i] as HTMLElement;
      segment.className = i < filled ? 'on' : i === filled ? 'next' : '';
    }

    const localCells = versus ? current.clears[localIndex] ?? 0 : current.cells[localIndex] ?? 0;
    const partnerCells = versus
      ? current.clears[partnerIndex] ?? 0
      : current.cells[partnerIndex] ?? 0;
    const total = Math.max(1, localCells + partnerCells);
    const share = Math.round((localCells / total) * 100);
    localChip.bar.style.width = `${share}%`;
    partnerChip.bar.style.width = `${100 - share}%`;
    const localMeta = current.players[localIndex] ?? current.players[0];
    if (localMeta) {
      localChip.name.textContent = `${localMeta.name} · ${t('game.you')}`;
      localChip.paletteDot.style.background = localMeta.paletteId ? paletteById(localMeta.paletteId).accent : '#7dd3fc';
    }
    localChip.chipScore.style.display = versus ? '' : 'none';
    localChip.chipScore.textContent = versus ? `${t('game.lines')} ${current.clears[localIndex] ?? 0}` : '';
    partnerChip.root.style.display = partnerIndex < 0 ? 'none' : '';
    if (partnerIndex >= 0) {
      const partnerMeta = current.players[partnerIndex];
      if (partnerMeta) {
        partnerChip.name.textContent = versus ? `${partnerMeta.name} · ${t('game.rival')}` : partnerMeta.name;
        partnerChip.paletteDot.style.background = paletteById(partnerMeta.paletteId).accent;
      }
      partnerChip.chipScore.style.display = versus ? '' : 'none';
      partnerChip.chipScore.textContent = versus ? `${t('game.lines')} ${current.clears[partnerIndex] ?? 0}` : '';
      const partnerConnected = partnerMeta?.connected ?? false;
      const dot = partnerChip.root.querySelector('.dot');
      if (dot) dot.className = `dot ${partnerConnected ? 'online' : 'warn'}`;
    }

    const nextKey = `${current.next[0]?.join(',')}|${current.next[1]?.join(',')}|${current.players[0]?.paletteId}|${current.players[1]?.paletteId}|${current.localPlayer}`;
    if (nextKey !== lastNextKey) {
      lastNextKey = nextKey;
      const localPalette = current.players[current.localPlayer]?.paletteId ?? 'aurora';
      const localKind = current.next[current.localPlayer]?.[0];
      if (localKind !== undefined) drawNextPiece(localChip.nextCanvas, localKind, localPalette, current.localPlayer);
      if (partnerIndex >= 0) {
        const partnerPalette = current.players[partnerIndex]?.paletteId ?? 'bloom';
        const partnerKind = current.next[partnerIndex]?.[0];
        if (partnerKind !== undefined) drawNextPiece(partnerChip.nextCanvas, partnerKind, partnerPalette, partnerIndex);
      }
    }

    const playing = current.phase === 'playing';
    const danger = playing ? dangerLatch.update(dangerRows(current.board), performance.now()) : (dangerLatch.reset(), false);
    boardWrap.classList.toggle('danger', danger);
    aurora.setDanger(danger);
    music.setMode(current.mode);
    music.setDanger(danger);

    // Countdown
    if (current.phase === 'countdown' && !current.paused) {
      const value = Math.max(1, current.countdown);
      if (value !== lastCountdown) {
        lastCountdown = value;
        countdownNode.replaceChildren(el('span', { text: String(value) }));
      }
    } else {
      if (lastCountdown !== 0) {
        lastCountdown = 0;
        countdownNode.replaceChildren();
      }
    }

    if (room.status === 'reconnecting' && room.role === 'guest') {
      setOverlay('reconnecting');
      return;
    }
    if (current.paused && (current.phase === 'playing' || current.phase === 'countdown')) {
      setOverlay('paused');
      return;
    }
    if (current.phase === 'won' || current.phase === 'lost') {
      setOverlay('result');
      return;
    }
    setOverlay('none');
  }

  function nextFrame(): void {
    if (disposed) return;
    if (view) {
      renderer.reduceMotion = api.settings.reduceMotion;
      renderer.effects = api.settings.effects;
      aurora.setLevel(api.settings.aurora);
      aurora.setReduceMotion(api.settings.reduceMotion);
      renderer.draw(view, performance.now());
    }
    raf = requestAnimationFrame(nextFrame);
  }

  function onState(next: ViewState): void {
    view = next;
    processEvents(next);
    paint(next);
  }

  const offState = room.on('state', onState);
  const offPause = room.on('pause', (info: { ms: number; reason: string } | null) => {
    pauseInfo = info;
    if (view) {
      view = { ...view, paused: Boolean(info), pauseMs: info?.ms ?? 0 };
      paint(view);
    }
  });
  const offStatus = room.on('status', () => {
    if (view) paint(view);
  });

  if (view) {
    processEvents(view);
    paint(view);
  } else {
    setOverlay(room.role === 'guest' ? 'waiting' : 'none');
  }

  fit();
  requestAnimationFrame(() => {
    fit();
    if (view) paint(view);
  });
  raf = requestAnimationFrame(nextFrame);

  return {
    node,
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      clearTimeout(firstFit);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('resize', fit);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      clearHold();
      aurora.dispose();
      dangerLatch.reset();
      offState();
      offPause();
      offStatus();
      document.body.classList.remove('playing');
    },
  };
}
