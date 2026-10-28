# Design decisions

This file records the decisions that materially shape Meldra, the alternatives considered, and the
consequences for future work. Observations are kept separate from assumptions.

---

## D1. The co-op mechanic: rows that need both players

**Problem.** Two players must share a puzzle without one player simply watching, following
instructions, or playing a separate board next to the other.

**Decision.** Both players drop their own pieces into one 10 × 20 arena. A cleared row counts as a
**Meld** only when it contains at least one block placed by each player. Five Melds win. Rows that
one player finishes alone still clear, still score, and still help the team — they just do not
advance the objective.

**Why this works.** The objective is structurally cooperative: because a piece is four cells and the
arena is ten wide, rows must be interleaved to reach five Melds. A strong player cannot carry the
objective alone. At the same time, the rule is explainable in one sentence and does not add a
special button or a menu.

**Alternatives considered.**

- *Two boards side by side with sent garbage.* Familiar, but it is the exact pattern Meldra is meant
  to distinguish itself from, and it makes most actions independent.
- *One piece controlled by both players.* Creates constant conflict resolution and is frustrating
  without voice chat; also weakens personal contribution.
- *Shared gauge filled by any clears.* Encourages simultaneous solo play rather than coordination.
- *Row ownership alternation (only player A can clear some rows).* Readable on paper, but it turns
  the board into two disconnected territories.

**Consequences.** The HUD must make objective progress and each player's contribution clear. The
renderer highlights rows with exactly one empty cell, because those rows are the invitations that
drive the core loop. Future modes can reuse the engine with a different objective (for example, a
Relay objective that alternates the active player).

**Status.** Implemented and unit-tested (plain clear vs Meld row, target victory, shared defeat).

---

## D2. Two pieces, one grid: spawn lanes and overlap resolution

**Problem.** Two simultaneous falling pieces can occupy the same cells, and a partner can lock a
block into a cell the other piece is passing through. Without a rule, the result depends on network
timing and can overwrite a locked block.

**Decision.**

- Player one's pieces spawn from column 1, player two's from column 5, so spawn cells never collide.
- A locked cell is never overwritten. If both pieces lock into the same cell on the same tick, the
  piece handled first (player 0, then player 1) owns it, and the other cell is dropped.
- After a lock, an active partner piece overlapping newly locked cells is lifted upward until it is
  free (up to four rows) rather than left embedded.
- Lock delay is 400 ms with at most 12 resets, so a lifted piece has a moment to react.

**Alternatives considered.** Blocking a lock while another piece occupies a cell (creates invisible
dependencies and stalls); letting the later piece overwrite (destroys the partner's work); treating
active pieces as solid to each other (makes the arena feel cramped and unpredictable at spawn).

**Consequences.** Overlaps are rare but deterministic. A future spectator or replay feature can
reproduce them exactly because the rules use fixed ordering, not animation timing.

---

## D3. Shared defeat

**Problem.** A co-op game needs failure to belong to the team, not to one player's private board.

**Decision.** If either piece cannot spawn, the match ends in defeat for both. The losing player is
recorded on the event but no individual blame is shown beyond the shared result screen.

**Trade-off.** A careless partner can end a good run. This is intentional for the first milestone
(shared fate), and the pause/chat-by-ping tools exist to coordinate. A future "Last Stand" rescue
rule (one player can spend a Meld charge to clear the spawn area) is a candidate after playtesting,
but it is not implemented.

---

## D4. Host-authoritative rooms over a relay (not peer-to-peer, not relay-simulated)

**Problem.** The browser client must be static and easy to host, while both players must see one
consistent arena. Options considered:

1. **Server-authoritative simulation** (like the Node server used by Kanka Kombat). Strongest
   integrity, but requires a stateful game server and a deployment target for it.
2. **Host-authoritative simulation with a dumb relay.** One browser runs the engine; the relay only
   forwards messages. Static hosting works as long as a relay exists.
3. **Peer-to-peer WebRTC.** No relay, but NAT traversal and invite ergonomics are worse for a game
   that should be shareable with a friend by code.

**Decision.** Option 2. `src/server/index.ts` is a static file server plus a two-socket room relay.
The host runs the simulation at 20 Hz, applies guest actions, and broadcasts snapshots. A guest
predicts its own piece and reconciles on the next authoritative snapshot.

**Security posture.** The host is trusted. For private, invite-only co-op with a friend this is
appropriate and keeps the deployment footprint tiny. It is explicitly *not* suitable for ranked
competition; if Meldra adds public matchmaking, the engine (already DOM-free and deterministic)
can move behind a server-authoritative room without changing its rules.

**Trade-offs.** Host tab closure ends the room; host latency is the guest's input latency; a
modified host can lie. All are documented in the README.

---

## D5. Two transports: a local WebSocket relay and a production broadcast relay

**Problem.** Rooms must work locally for testing, and the same client must work on GitHub Pages,
which can serve files but cannot host a WebSocket server.

**Decision.** The room layer is transport-agnostic. Localhost and the Playwright suite use the
minimal `ws` relay in `src/server/index.ts`; builds served anywhere else use a Supabase Realtime
broadcast channel, which delivers a message to the other subscriber without storing it. Both
transports carry the same `PeerMsg` protocol, so the host/guest state machines do not branch.

Room codes are five characters from an unambiguous alphabet (no I, L, O, 0, 1). The local relay
accepts at most two sockets per room, rate-limits messages, caps payloads at 16 KiB, and reaps empty
rooms. The broadcast room is named after the code and disappears when both clients leave.

**Why Supabase Realtime.** It is already used by Kanka Kombat and Leap Buddies, so it adds no new
vendor, no paid tier, no database table, and no authentication. A room needs two browsers and no
persistence; an ephemeral broadcast is the smallest capability that meets that requirement. The
anon key is a public client value and is the only credential in the bundle; no service-role key or
user data is present. Since Kanka Kombat's room layer already demonstrated the pattern, Meldra
reuses the session shape rather than inventing a networking system.

**Alternatives considered.** A dedicated Worker/Durable Object (a real requirement only for public
matchmaking, ranked integrity, or persistent rooms); a hosted WebSocket provider (adds a dependency
and a bill for the same ephemeral room); Firebase (heavier data model than needed); WebRTC (NAT and
invite ergonomics are worse for a code-based invite).

**Consequences.** The host is still authoritative and the guest can only act through host-validated
messages. `VITE_WS_URL` overrides the transport for self-hosted relays, and `?net=supabase` lets a
local static build exercise production networking. Broadcast channels provide no close event, so
the guest sends a heartbeat and the host treats silence as a disconnect; the guest watchdog does the
same for the host. Room membership still lives in the two browsers, so a host reload loses the
match.

---

## D6. Tick rate, snapshot rate and client prediction

**Decision.** Simulation step 50 ms (20 Hz); snapshots on every simulation step; guest input applied
locally first, then acknowledged by sequence number.

**Rationale.** At 20 Hz the authoritative state is cheap to encode (about 300 bytes) and looks
smooth because rendering runs at display refresh and interpolates only the falling visual through
the renderer's own rAF. Sending at 20 Hz also makes the partner's piece appear responsive on a LAN
and acceptable over home broadband. Prediction is limited to the local player's own actions; the
partner's piece is shown with the natural network delay, which is unavoidable in a host-authoritative
design.

**Trade-off.** On a 150 ms connection the partner's piece lags noticeably. A future interpolation
buffer could smooth this by rendering remote state ~100 ms in the past; it is not implemented because
it adds complexity without changing fairness in a co-op game.

---

## D7. Reconnection and disconnect handling

**Decision.** A guest stores a room token in `sessionStorage`; the host keeps the slot for 30
seconds and pauses the arena meanwhile. A reload with the same token reclaims the slot and resumes.
After 30 seconds the match is abandoned, both clients return to the lobby/home with an explicit
message.

**Why.** A page reload during a co-op run is common (phone rotation, accidental refresh). Silently
pausing is worse than showing a countdown; silently dropping the player's board would corrupt the
shared state.

**Not implemented.** Host migration and asynchronous takeover. The host leaving ends the room with a
clear message rather than pretending the match can continue.

---

## D8. Client-side i18n with a typed dictionary

**Problem.** English and Turkish must be complete, switch live, and not drift as features land.

**Decision.** `src/client/i18n.ts` defines `EN` as the source-of-truth object and types `TR` as
`Record<keyof typeof EN, string>`. TypeScript therefore fails the build when a Turkish key is
missing, and a unit test additionally checks for empty strings and mismatched `{placeholders}`.
`data-i18n*` attributes and a direct `t()` call cover static and dynamic text. The choice persists;
a first visit follows the browser language and the manual selector always wins.

**Why not a library.** The interface needs one feature (flat keys, interpolation), and a dependency
would add bundle weight without solving completeness better than the type system. This mirrors the
pattern used in LeapBuddies, adapted to TypeScript and a strict key type.

**Consequences.** Any new player-facing string must be added to both dictionaries; this is enforced
at typecheck time. Turkish text expansion is accommodated by flexible layouts, and the mobile suite
asserts no horizontal overflow in Turkish.

---

## D9. Palettes and non-colour ownership cues

**Problem.** Colour customization must not destroy the ability to tell whose blocks are whose, and
should not rely on colour perception alone.

**Decision.** Four palettes, each with seven legible colours on the near-black arena. Ownership is
encoded twice: player one gets a bright rim and a corner dot; player two gets a diagonal weave and a
corner ring. Every kind also carries a small glyph (bar, square, triangle, wave, mirrored wave,
corner). The lobby preview paints the real block art on the real background, including a partner
block so the contrast between the two ownership treatments is visible.

**Alternatives considered.** A single per-player colour (loses piece-kind readability and makes the
board monotonous); relying only on a name label (invisible on a crowded board); outlines only (the
weave is easier to spot at speed and survives small cell sizes).

**Trade-off.** The weave adds contrast noise on very small cells; it is drawn at low opacity and the
rim/ring remain the primary cue.

---

## D10. Input model

**Keyboard.** `A/D` or arrows to move, `W/↑` rotate, `Q` rotate back, `S/↓` soft drop, `Space`
hard drop, `C` mark column, `Esc` pause, `H` help. Movement and soft drop repeat from an internal
timer with a 210 ms delay and 85 ms interval, so browser key-repeat settings do not affect the
game.

**Touch.** Six pads arranged as move/soft on the left and rotate/drop/mark on the right, each at
least 50 × 50 CSS px on a 390 px viewport. Holding a pad repeats at 220 ms / 90 ms. Dragging on the
arena slides the piece by cell-width thresholds and soft-drops when dragged downward. Tapping the
arena does nothing, deliberately: an ambiguous tap-to-rotate would cause accidental placements.

**Why not swipe gestures for rotation.** They conflict with horizontal dragging and with browser
edge gestures; explicit pads plus drag cover the same actions without ambiguity.

**Accessibility.** Every pad has an accessible name; `Escape` reaches pause; the board exposes its
state through ARIA-friendly attributes for tests; motion can be reduced; sound has a visible toggle;
critical state (score, objective, danger) is never conveyed by sound alone.

---

## D11. Mobile layout

**Decision.** Below 700 px the HUD becomes a compact row (score, objective/Melds, pause), player
chips and next previews sit above the arena, and the board takes the remaining height while keeping
the 1:2 ratio. The board height is computed from the viewport minus a fixed chrome budget rather
than a percentage, which keeps the touch pads inside one viewport at 390 × 844. Landscape on short
screens restores a three-column layout and hides the touch pads.

**Verification.** Playwright drives a 390 × 844 touch context, asserts the touch pad's bottom edge
is inside the viewport and that `scrollHeight <= innerHeight`, and exercises pads and dragging. This
is emulation, not a physical device; the limitation is recorded in the README.

---

## D12. Presentation

**Decision.** A dark aurora/glass interface with restrained motion: rounded blocks with a top-light
gradient, soft glowing active piece, dashed ghost, a danger band when the stack reaches the top six
rows, row-clear flashes, Meld rings, and a pulsing hint on rows with one gap. Sound effects are a
small WebAudio synthesizer (movement tick, rotate chirp, lock thud, clear arpeggio, Meld chime,
win/lose pads, ping); music is the six supplied tracks described in D15. No sampled sound effects
or third-party visual assets are used.

**Why.** The game's identity is the shared arena; effects exist to explain state changes (what
cleared, who contributed, what is dangerous), not to decorate. Reduced-motion disables the pulsing
and drift animation.

---

## D13. Reference analysis boundaries

**What was inspected.** The task's local REA installation (`X:\REA`), its `USAGE.md`, and its
launcher wrappers; `rea.sh --version` returns `6.7.0`, so the tooling is functional. The Tetris
Effect: Connected installation directory was located and its `version.txt`
(`version:20260706182922`) was read to confirm the reference build is present.

**What was deliberately not done.** The reference game was not launched, hooked, decompiled,
unpacked, or mined for assets. REA was not pointed at it, because that would be binary analysis of
protected software and is outside Meldra's reference rules. No screenshots, audio, textures, UI
artwork, or code were extracted.

**Consequence.** No claim in this repository is based on a hands-on observation session of Tetris
Effect: Connected. The co-op rule, feedback hierarchy, and onboarding structure were designed from
first principles and from the author's prior co-op projects (Kanka Kombat for room flow, LeapBuddies
for bilingual UI and touch guidance). If a supervised observation session is available later, it
should be recorded here as observations separate from assumptions — and still translated into
Meldra-specific mechanics rather than copied.

---

## D14. What is intentionally out of scope for v0.1.0

Ranked matchmaking, accounts, persistent profiles, cosmetics inventory, a large mode roster, boss
encounters, spectator mode, replays, chat, and monetization. The core loop, lobby, language,
palette preview, control guide, mobile layout, tests, and documentation came first. Music was also
out of scope for the first milestone; it is now implemented (D15) without changing that priority
order.

---

## D15. Soundtrack state machine and loop strategy

**Problem.** Six supplied songs have to follow the game without becoming a source of bugs: lobby
navigation must not restart them, co-op must not stream audio, danger must not flap, and the MP3s
are songs rather than authored loops.

**Decision.** A single `TrackId` map in `src/client/soundtrack.ts` resolves the track from screen,
mode, lobby theme and danger. A `MusicManager` owns exactly two `<audio>` decks and one
`AudioContext`/`AnalyserNode`; both decks feed the analyser, which feeds a master gain. Track changes
use a 900 ms gain crossfade, and the outgoing deck's source is released after the fade. The manager
is a singleton, so re-rendering a screen cannot create a second player.

**Looping.** Measurement of the supplied files (RMS of first/last two seconds; see
`Soundtrack/README.md`) showed quiet tails on Pixelated Memories and Same Frequency, and audible
seams on Friendly Fire and Pressure Loop. Native `audio.loop` was rejected. Instead, with 1.25 s
remaining, the idle deck starts a fresh copy and crossfades in over 900 ms. One More Round is the
most loop-friendly track, but all six use the same strategy. A throttled tab that misses the window
restarts on `ended` as a safety net.

**Danger.** `DangerLatch` enters at six empty rows from the top, requires the stack to fall back to
eight empty rows for 2.5 s before leaving, and blocks re-entry for 1.2 s. The values are code
constants, not user settings: they are gameplay tuning, not a preference. Co-op clients evaluate
the latch on the same authoritative board, so they switch together.

**Why local playback.** Audio through the relay would multiply bandwidth (tens of MB per match),
desynchronise on latency, and hand the host control of the guest's speakers. Each client loads the
same named track from its own copy of the repository.

**Alternatives considered.** One element with volume fades (cannot overlap, so it cannot crossfade);
audio-buffer scheduling via `AudioBufferSourceNode` (decodes whole 3-minute files, delays start, and
needs custom pause/seek handling); a managed music service (new dependency and account for six
already-committed files); streaming through the relay (rejected above).

**Trade-offs and consequences.** The repository carries ~23 MB of MP3s, but only the wanted track is
requested. Two detached audio elements exist for the life of the page. MP3 encoder padding is
masked, not removed. Browsers block the first play until a gesture; a guest who reloads into a match
gets music on their first interaction. A 404 or decode failure marks the track unavailable, logs
once, and leaves the game silent rather than throwing. Duel uses `Friendly Fire`; the other modes
map to the solo or co-op track in `baseTrack()`.

---

## D16. Liquid Aurora layering and restraint

**Problem.** A music visualizer is easy to make attractive on an empty board and harmful on a full
one. It must not compete with blocks, ghosts, grid lines, danger warnings, or touch targets.

**Decision.** The aurora is a separate canvas inserted as the first child of `.board-wrap`, with
`z-index: 0`, `pointer-events: none`, and no effect on layout. The board canvas keeps `z-index: 1`
and draws its background at 90–93% alpha, so at most a tenth of the aurora reads through the grid.
The frame is sized to the arena width + 56 px and centred, leaving a 28 px light rim on every side
rather than washing the whole column. Ribbons live mostly near the edges; five wide, low-alpha
horizontal strokes, two slow side curtains and four radial edge washes use teal, indigo, violet and
blue. The renderer runs at 30 fps,
caps DPR at 1.5 (2 for Enhanced), and stops on `document.hidden`. One shared `AnalyserNode` provides
bass, mid and overall energy, smoothed asymmetrically (fast attack, slow release). With no live
audio it falls back to a slow deterministic breath — it never claims to react when it is not.

**Intensity.** Subtle uses 55% of the ribbon intensity; Enhanced uses 100% with an additional 1.35×
scale, so the two levels are visibly distinct. Danger adds a modest 14% and slightly faster drift;
the red danger band remains the primary warning. Off stops the loop and clears the canvas. Reduced
motion paints a single static frame. Settings persist under the existing `meldra.settings.v1` key.

**How it was tuned.** Screenshots were captured through Playwright with the arena filled across its
width and again at the danger threshold, on desktop and at 390 × 844. The first version stretched
the layer across the whole middle column; screenshots showed oversized blurred blooms, so the frame
was tightened to the arena and alphas were cut by roughly 40%. A second pass widened the rim to
28 px and added two vertical side curtains so the ribbons read as movement around the arena rather
than only a uniform halo. Most of the final effect is visible in the rim, with only a faint tint
through the board.

**Alternatives considered.** CSS-only blurred blobs (many large animated elements are expensive on
phones); WebGL shaders (unnecessary complexity for a 2D effect); drawing inside the board renderer
(would couple ambient art to the deterministic board and risk affecting gameplay); a full-column
canvas (tested and rejected visually).

**Trade-offs.** Ribbon shapes are subtle in a still frame because the board covers most of them;
the motion is the effect. There is no beat detection — only smoothed spectral energy — which keeps
the response organic and avoids jitter. The layer is decorative and aria-hidden; no gameplay
information depends on it.

**Reference note.** The aurora was designed from the supplied soundtrack and Meldra's own arena
palette. No visual material from Tetris Effect: Connected or another game was observed, captured,
or reused; the D13 boundary still applies.

---

## D17. Mode design, the compact menu, and static deployment

**Duel shares the arena.** A separate board per player would be the familiar versus shape, but it
would discard Meldra's defining constraint. Instead both players keep dropping into the same
10 × 20 arena, and the player who *closes* a row scores it. Eight closed rows win. The opponent's
blocks remain in the arena as obstacles, and because the spawn lanes are fixed, burying the other
player's column is a legitimate strategy. Top-out is no longer a shared defeat: the player whose
piece cannot spawn loses the duel. This reuses the existing deterministic engine and keeps the
visual identity intact.

**Relay alternates the piece.** Only one piece is in play at a time. The active player receives a
piece, locks it, and the turn passes; the engine gates `applyAction` and gravity on `state.turn`.
The shared Meld objective remains, so Relay is cooperative sequencing rather than a race. The HUD
shows whose turn it is, and the inactive player's next queue is hidden behind the turn label.

**Rift is a timed co-op survival.** Three 60-second waves use the existing gravity ramp; the mode
ends in victory when the third wave elapses and in defeat on a spawn failure. Progress is shown as a
wave counter. This gives the co-op track a second, more pressured context without adding a new
simulation.

**Architect is a fixed puzzle.** The mode starts with a deterministic half-built stack in the
bottom six rows, leaving the spawn area clear, and asks for ten cleared rows. Endless is the
opposite pressure profile: no target, no objective, just survival and score.

**Difficulty is one shared pace, not per-mode variants.** Playtests described the mid-match speed
jump as the point new players fall off. Three gravity profiles change both the starting interval and
the ramp: Zen 1200 → 380 ms, Normal 850 → 280 ms, Hard 320 → 110 ms. One
persisted choice keeps the menu short and lets a player change the whole session's feel in one tap
instead of configuring seven modes. The online host owns the choice; it travels in the welcome,
lobby and snapshot messages (protocol v2), so a guest can never simulate a different curve than the
host and the lobby shows the inherited value before the match starts.

**Normal was retuned after release.** The first curve dropped from 850 ms to a 150 ms floor in
about fifty seconds, so the second half of every Normal match sat at the hardest pace; players
reported that as a difficulty wall rather than a ramp. The floor is now 280 ms and the ramp runs at
5 ms per second, reaching the floor after roughly two minutes. The change only alters the values in
[constants.ts](src/shared/constants.ts) — the single `gravityTicks` function still owns every pace
question, so Zen, Hard, Sudden Death, chaos gravity events and Clash Gravity Surge keep their
multipliers unchanged on top of the new base curve.

**Clash is not shipped.** A four-player team mode needs a wider arena, four spawn lanes, and a
four-player room protocol. Building it on top of the two-player relay would either break the
shared-arena geometry or produce a mode that is not actually team-versus-team. It remains a design
proposal, documented rather than faked.

**Menu structure.** The first version spread identity, a full control guide, three calls to action,
and a technical relay note across a two-column page. Playtests on desktop and phone showed the
first screen was doing too much. The 0.2.0 menu is a single compact card: four primary modes in a
two-by-two grid, a collapsed "More ways to play" disclosure for the other three, one join strip,
and a separate identity panel. Controls moved into the guide that already existed. The technical
relay note, which told players to run `npm run server`, was removed from the interface entirely; it
is a development instruction, not player copy.

**Static hosting.** GitHub Pages serves the built client from `/meldra/` on the account's existing
custom domain. Vite's `base` is set at build time (`MELDRA_BASE=/meldra/`) and the soundtrack path
is derived from `import.meta.env.BASE_URL`, so every asset request is prefixed correctly. The
workflow uploads only `dist/`; `dist` is git-ignored. No Cloudflare DNS record, proxy setting, or
unrelated route was changed. GitHub Pages canonicalises `www.xiondigital.net` to
`xiondigital.net`, so the www URL 301s to the apex page.

**Verification boundary.** The production transport and the built client are both exercised in
Playwright: two contexts create a room with `?net=supabase`, ready up, start, and confirm a host
hard drop reaches the guest. Deployment is verified separately by opening the public URL and
checking assets, gameplay, and the room flow.

---

## D18. Room rules, the Meld Meter, hazards and the Duel attack layer

**Rules live in the room, not the menu.** Together and Duel already have a lobby with a host and a
guest, so the rules card sits there: the host edits it before starting, the guest sees the same
controls disabled, and the values travel in the welcome and lobby messages (protocol v3). Solo,
Relay and Rift keep their designed shape. Nothing about the menu changed, which also preserves the
compact first screen from D17.

**One rule set, one simulation.** `normalizeConfig` is the single coercion point: the host clamps
everything it receives, ignores options that do not belong to the mode (Clash only in Duel, meteors
and chaos only in Together), and every snapshot carries the resulting config. A guest therefore
never reconstructs a different rule set, and the rules are locked once a match starts so a host
cannot change the pace mid-simulation.

**Meld Meter: a recovery valve, not a win button.** The charge rate is tied to the pace (Zen 30 s,
Normal 60 s, Hard 120 s) rather than to clears, so it arrives at the same point in a match regardless
of skill. It removes locked crystals only: both falling pieces are preserved, the wave does not
score, and it does not count as a row or a Meld. Together shares one charge because the arena is
shared; Duel gives each player a private charge that only dissolves their own crystals, which keeps
it tactical rather than a free board wipe. Activation requires a full meter, resets to zero, and
does nothing when no crystals are left, so two simultaneous activations produce exactly one event.

**Meteor Storm is telegraphed space, not random punishment.** The landing cell is the top of a
random column and is shown for 2.5 seconds. Impact removes that cell and its four neighbours;
Starfall (18 % when enabled) removes a 3 × 3 area. Both bypass scoring entirely, so a meteor can
open room or ruin a stack but can never manufacture a Meld. The interval starts at 20–35 seconds
and is tuned by the config, not by the score.

**Chaos events are announced and exclusive.** A 3-second lead-in, a visible countdown and a
single active event prevent the two gravity modifiers from stacking or cancelling each other. The
scheduler never repeats the same event twice in a row, and Blackout dims only the arena shell:
locked crystals and the active piece keep their contrast.

**Combos reward continuity without double counting.** A clear inside the five-second window
increments a chain value carried on the event; particles, ring size and the clear chord scale with
it. Melds are still counted per row by the clearing pass, so a chain can never award extra Melds.

**Clash Attack is bounded on every axis.** Points come only from cleared rows, a charge costs four
points, at most two charges bank, and there is a six-second cooldown. Obstruction refuses columns
without headroom and drops two cells; Gravity Surge lasts ten seconds on the rival only; Crystal
Shell plates at most three crystals for eight seconds and expires into a normal clear pass. Shells
are deliberately visible (a cracked white-violet plate) so the blocked row reads as a status, not
a bug. The combination of caps, expiry and refusal leaves no attack that can force an unavoidable
loss.

**Sudden Death is a different objective, not a harder Duel.** The row target is zero, the first
arena to top out loses, and a second ramp multiplies gravity down toward 50 % over two minutes.
This keeps the existing top-out rule and avoids a separate win condition.

**Visual effects are local.** The help panel stores Full/Reduced/Off per browser. The renderer
drops decoration first, then waves and fragments; shells, meteor telegraphs and chaos dimming are
treated as essential information and stay legible even at Off. Nothing about the setting is sent
to the partner.

**Wild Blocks and Gravity Flip are deferred.** A wildcard needs a row-completion rule that cannot
be farmed for free Melds, and Gravity Flip needs collision and lock rules that stay readable with
two active pieces in one arena. Shipping either as a half-rule would undermine the deterministic
engine, so they are documented as open work rather than faked.
