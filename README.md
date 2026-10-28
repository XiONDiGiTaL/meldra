# Meldra

**Different colours. One shared fate.**

Meldra is an original browser falling-block puzzle built around a single 10 × 20 arena. Two
players steer their own pieces inside that shared space, so every opening and every mistake
belongs to both of them.

**[Play Meldra at xiondigital.net/meldra](https://www.xiondigital.net/meldra/)** — no account,
no install. The www address redirects to the canonical `https://xiondigital.net/meldra/`
address served by GitHub Pages.

## Screenshots

| Main menu | Solo / Endless |
| --- | --- |
| ![Meldra main menu](docs/screenshots/menu.png) | ![Solo arena](docs/screenshots/solo.png) |

| Duel | How to play |
| --- | --- |
| ![Duel room](docs/screenshots/duel.png) | ![How to play guide](docs/screenshots/how-to-play.png) |

| Co-op room | Phone layout |
| --- | --- |
| ![Co-op lobby](docs/screenshots/co-op.png) | ![Phone layout](docs/screenshots/mobile.png) |

## Modes

| Mode | Players | Goal | Status |
| --- | --- | --- | --- |
| **Solo** | 1 | Clear 12 rows. | Playable |
| **Together** | 2 online | Build a Meld target (5–100) on one shared board, or play Endless Together. | Playable |
| **Duel** | 2 online | Share the arena, but only rows *you* finish score. Reach the row target or win Sudden Death. | Playable |
| **Relay** | 2 online | Take turns with a single falling piece and build five Melds together. | Playable |
| **Rift** | 2 online | Survive three 60-second waves while gravity keeps rising. | Playable |
| **Architect** | 1 | Clear 10 rows from a deterministic half-built stack. | Playable |
| **Endless** | 1 | No target. Keep the stack alive and chase a high score. | Playable |
| **Clash** | 4 online | Team-versus-team shared arenas. | Design proposal; needs four-player netcode |

Solo modes run entirely in the browser. Online modes use a five-character room code; the host
selects the mode and the guest inherits it.

### Difficulty

A single **Difficulty** control on the menu sets the pace for whatever you play next:

| Pace | Fall starts at | Gravity floor | Feel |
| --- | --- | --- | --- |
| **Zen** | 1200 ms | 380 ms | Gentle ramp; a first match never turns frantic. |
| **Normal** | 850 ms | 280 ms | Eases over about two minutes; no mid-match spike. |
| **Hard** | 320 ms | 110 ms | Fast from the first piece. |

The choice is saved with the other preferences. In a room, the host can change the pace in the
lobby before starting; it is shown to both players and used by the shared engine. The guest
inherits it and sees the same value in the arena HUD.

### Room rules and modifiers

Every hosted room exposes a **Room rules** card. The host edits it before starting; the guest
sees the same values read-only, so both clients simulate the identical rule set.

| Together | Choices | Effect |
| --- | --- | --- |
| Objective | Target Melds / Endless | Endless removes the victory target and runs until the arena tops out. |
| Meld target | 5, 10, 15, 20, 30, 40, 50, 75, 100 | Longer matches only; the pace is untouched. |
| Meld Meter | Off / On | A shared charge that fills automatically and dissolves locked crystals. |
| Meteor storm | Off / Standard / Standard + Starfall | Telegraphed impacts that break the stack, with a rare wider Starfall. |
| Chaos events | Off / Occasional / Frequent | Announced, one-at-a-time gravity and light shifts. |

| Duel | Choices | Effect |
| --- | --- | --- |
| Objective | Target rows / Sudden Death | Sudden Death removes the target; the first arena to top out loses. |
| Rows to win | 3, 5, 8, 12, 15, 20 | The row target for a normal Duel. |
| Meld Meter | Off / On | Each player charges a private meter that dissolves only their own crystals. |
| Clash Attack | Off / On | Bank cleared rows, then spend them to disrupt your rival. |

**Meld Meter.** The shared charge fills in 30 seconds on Zen, 60 on Normal and 120 on Hard. When
full it becomes an animated liquid-glass button reading **MELD METER MAXED**; click it, tap it,
or press `M`. It dissolves every locked crystal in the arena, keeps both falling pieces, and never
scores a row or a Meld. In a Duel it only dissolves your own crystals. Two simultaneous
activations cannot clear twice.

**Meteor storm.** Each meteor is a dark crystal cube with a burning star inside. Its landing cell
is telegraphed for 2.5 seconds; on impact it destroys that cell and its four orthogonal
neighbours. Starfall is rarer, brighter, and clears a 3 × 3 area. Neither counts as a row clear or
a Meld.

**Combo chains.** Clears inside a five-second window escalate the chain, the glow, the fragment
count and the sound. A single clear still only awards the Melds it actually completes.

**Chaos events.** Low Gravity, Gravity Surge, Blackout and Color Surge are announced three seconds
before they begin, display their remaining time, and never run at the same time as another event.

**Clash Attack.** Cleared rows bank attack points, up to two charges, with a six-second cooldown.
Obstruction drops two crystals into a safe column of the rival arena, Gravity Surge accelerates
their fall for ten seconds, and Crystal Shell plates three of their crystals for eight seconds so
those cells cannot clear. Charges are capped and shells expire, so no attack can force an
unavoidable loss.

**Visual effects.** The help panel offers Full, Reduced and Off. This is a local preference: it
never changes what your partner sees.

### What makes Meldra different

- **One arena, two owners.** Player one spawns on the left, player two on the right. A locked
  block stays in the shared space for both players.
- **Melds.** A cleared row containing both players' colours is a Meld. Five Melds win Together
  and Relay, which rewards leaving the last gap for your partner.
- **One shared fate.** In co-op modes, a piece that cannot spawn ends the match for the team.
  In Duel, that same top-out loses the match for the player who owns the blocked spawn.
- **Readable without colour.** Player one's blocks carry a bright rim and corner dot; player
  two's carry a diagonal weave and a ring. Every palette is checked against the arena floor.
- **The arena reacts.** Six supplied tracks crossfade through lobby, mode, and danger states.
  The Liquid Aurora reads the active track through one shared analyser.

## How to play

1. Pick a mode on the menu, or enter a partner's five-character room code.
2. Steer your own piece. You cannot move through locked blocks, walls, or the floor.
3. In **Together**, **Relay**, and **Rift**, finish rows that contain both colours to earn Melds.
4. In **Duel**, finish eight rows before your rival. Your opponent's blocks are obstacles, not
   teammates, and a blocked spawn loses the duel for that player.
5. In **Solo**, **Architect**, and **Endless**, the arena is yours; top-out ends the run.

Press **C** (or the Mark button) to flag a column for your partner for three seconds.

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Move | `A` / `D` or `←` / `→` | pads, or drag horizontally on the arena |
| Rotate | `W` or `↑` | rotate pad |
| Rotate back | `Q` | — |
| Soft drop | `S` or `↓` | soft-drop pad, or drag down |
| Hard drop | `Space` | drop pad |
| Mark column | `C` | mark pad |
| Meld Meter | `M` | tap the meter above the arena |
| Pause | `Esc` | pause button |

Holding a movement pad or key repeats the action at a fixed rate. The page does not scroll while
you play, and the touch layout keeps the arena, pads, and pause control inside one viewport.

## Online rooms

Meldra's client is static. Rooms are **host-authoritative**: the host browser runs the engine,
applies guest input, and broadcasts full snapshots. The guest predicts its own piece locally and
reconciles against each snapshot.

The transport is a **Supabase Realtime broadcast channel** — the same disposable relay pattern
already used by Kanka Kombat and Leap Buddies. It stores nothing, needs no database table, no
authentication, and no game server. Each room is an ephemeral channel named after its five-character
code; messages go to the other participant and are discarded.

Why this is the smallest suitable backend on GitHub Pages:

- GitHub Pages can only serve static files, so a WebSocket server cannot live there.
- Supabase Realtime is already part of the existing infrastructure; using it adds no new vendor
  or paid tier.
- A room needs two browsers and no persistence, so a broadcast channel is sufficient.
- The publishable anon key is a public client value. No service-role key, secret, or user data is
  present in the bundle. Match state stays in the two browsers.

The Supabase URL and publishable anon key can be overridden at build time with
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Locally, Meldra uses the Node WebSocket relay
instead; append `?net=supabase` to a local static build to exercise the production transport.

## Local development

Requires Node 20 or newer.

```bash
npm install
npm run dev             # http://localhost:5191
npm run server          # room relay + static server on http://localhost:8787
```

The dev client automatically looks for the WebSocket relay on port 8787. To test the exact
production build locally:

```bash
npm run build
npm run server          # serves dist/ at http://localhost:8787
```

With a phone on the same network, open the host machine's LAN address. For a static host other
than GitHub Pages, set `VITE_WS_URL` to a reachable WebSocket relay at build time, or let the
client use the Supabase broadcast transport (the default off localhost).

The README images are regenerated from a real local session instead of being hand-edited:

```bash
npm run build
PORT=8788 STATIC_DIR=dist npm run server   # in another terminal
npm run screenshots                        # writes docs/screenshots/*.png
```

## Architecture

```text
src/
  shared/            deterministic rules, no DOM and no clock
    constants.ts     board size, tick rate, lock delay, per-mode targets, modifier tuning
    config.ts        host-owned room rules, presets and wire coercion
    pieces.ts        piece tables, rotations, collision
    engine.ts        create/apply/advance, clearing, Melds, meter, meteors, chaos, Clash, Rift
    protocol.ts      peer messages, room codes
    types.ts         state, actions, events, snapshot wire types, mode lists
  client/
    app.ts           screens, room lifecycle, help, settings, language and music
    net.ts           transport selection, host/guest rooms, solo room, prediction
    views/home.ts    compact mode picker, join strip, identity
    views/lobby.ts   room code, player cards, readiness, host start
    views/game.ts    arena HUD, overlays, keyboard/touch input, per-mode goals
    render.ts        canvas arena, block sprites, previews, effects
    soundtrack.ts    track map, mode routing, danger latch, aurora helpers
    music.ts         two-deck playback, crossfades, analyser, autoplay recovery
    aurora.ts        Liquid Aurora canvas layer
    i18n.ts          typed EN/TR dictionary and DOM applier
    palettes.ts      palette definitions and cycling
    settings.ts      persisted preferences (safe storage wrappers)
  server/index.ts    developer static server + WebSocket room relay (/relay, /health)
Soundtrack/          the six supplied MP3s and their documentation
docs/screenshots/    the images used above
.github/workflows/   GitHub Pages build and deploy
vite.config.ts       dev Soundtrack serving, build copy, configurable base path
```

**Determinism.** The engine uses tick-counted timers, a seeded xorshift bag per player, fixed
action ordering, and no wall clock. The unit suite replays an action script twice and compares
state hashes.

**Bandwidth.** Snapshots encode the board as 20 nine-character rows and include both pieces,
queues, counters, and recent events. A two-player room sends roughly 20 snapshots per second.

## Deployment

The game is published to GitHub Pages from the `main` branch by
[.github/workflows/pages.yml](.github/workflows/pages.yml):

1. `npm ci`
2. `npm test`
3. `MELDRA_BASE=/meldra/ npm run build` — every JS, CSS, and soundtrack URL is prefixed with
   `/meldra/`.
4. `actions/upload-pages-artifact` and `actions/deploy-pages`.

GitHub Pages serves project sites on the account's custom domain, so the build appears at
`https://xiondigital.net/meldra/` without a separate DNS record. The existing apex and `www`
records still point at GitHub Pages through Cloudflare; no DNS records, proxy settings, or
unrelated routes were changed. GitHub Pages canonicalises `www.xiondigital.net` to
`xiondigital.net`, so the www address 301s to the same page.

The repo's Pages source is set to **GitHub Actions**, not a branch, so `dist/` is never committed.

## Tests

```bash
npm test                # 75 unit tests: rules, modifiers, difficulty, Duel/Relay/Rift, wire format, i18n, music
npm run test:e2e        # 18 Playwright tests: co-op, Duel, room rules, Relay, Rift, difficulty, Supabase
```

The Playwright suite uses two isolated browser contexts and covers:

- Create, join, ready, start, shared inputs, shared pause, defeat, rematch, and guest reconnection.
- Duel mode selection, room inheritance, per-mode music routing, and synced boards.
- A host selecting Zen and a guest inheriting the pace in the lobby and the HUD.
- Room rules syncing to the guest, guest read-only controls, the Meld Meter in play, Sudden
  Death, and the Clash panel.
- Relay turn handoff and Rift wave display.
- Architect debris and Endless's no-target goal.
- A real room over the production Supabase broadcast transport (`?net=supabase`).
- Invalid codes, a 390 × 844 touch layout, Turkish live switching, and help.
- Soundtrack byte ranges, live analyser data, mute, danger routing, aurora levels, and reduced motion.

`npx playwright install chromium` is required once. The GitHub Actions workflow runs unit tests,
not the browser suite.

## Known limitations

- **Host authority.** A modified host could report any score. This is acceptable for private
  rooms with invited players, but not for ranked play.
- **No host migration.** If the host closes the tab, the room ends after the guest's watchdog
  expires. The host browser is the simulation authority.
- **Supabase free tier.** Broadcast is ephemeral and subject to Supabase's free-tier quotas.
  For a larger public launch, the same protocol can move to a dedicated Worker or WebSocket
  relay without changing the game rules.
- **Background tabs.** A throttled host tab slows the match. The 30-second disconnect pause
  treats a silent guest as offline, but cannot detect a throttled host on its own.
- **Physical devices.** Touch and phone layouts are verified with Chromium device emulation at
  390 × 844, not on a physical iPhone or in Safari.
- **Wild Blocks and Gravity Flip.** These two experimental modifiers are designed but not
  shipped: Wild Blocks need a row-completion rule that cannot be exploited for free Melds, and
  Gravity Flip needs collision rules that stay readable in a two-piece shared arena. Every other
  modifier in this document is implemented.
- **Clash (four-player).** A four-player team mode needs a wider arena and four-player room
  protocol. The room-level Clash Attack modifier above is implemented for two-player Duels.
- **Music.** Playback is local, six MP3s with crossfaded loop points. Autoplay rules mean a
  freshly loaded tab starts music after the first gesture.

## Documentation

- [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) — rules, authority, conflict resolution, networking,
  localization and trade-offs.
- [CHANGELOG.md](CHANGELOG.md) — what changed in 0.2.0.
- [Soundtrack/README.md](Soundtrack/README.md) — track assignments, durations and loop behaviour.
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — dependencies, licenses, reference material.

## Originality and third-party material

Meldra's code, interface, block art, palettes, and synthesized audio are original. Reference
analysis was limited to high-level, publicly observable principles; no protected expression,
assets, or source code from another game is included.

## Rights and permissions

Copyright © 2026 XiØN. All rights reserved.

Except for third-party material and rights or permissions arising under applicable law or platform
terms, no license is granted to use, copy, modify, redistribute, or commercially exploit Meldra's
original code or assets without prior written permission. Public availability of this repository
does not, by itself, make Meldra open-source software.
