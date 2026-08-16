# Phased Delivery Plan

**Source spec:** `banpick-design-spec.md` (Accepted, 2026-07-28)
**Companion:** `SPEC-GAPS.md` — every item G1–G14 closed (D10–D26).
**Progress:** Phases 0–4 closed. Phase 5 (event log export and instrumentation) is open — and per its own note, it is the most valuable deliverable in the plan.
**Scope, ~~settled (D19)~~ reopened (D37, 2026-08-15):** two-player casual match tool, **plus a tournament layer**. ~~There is no tournament layer and there will not be one — Phase 7 is deleted, not deferred.~~ Phase 7 is **undeleted** and lives in its own document, [`TOURNAMENT-PLAN.md`](TOURNAMENT-PLAN.md), because it is large enough to need one and because reinstating it into a plan that spent four phases explaining why it would never exist would be harder to read than either document alone. The global ban tier survives unchanged — a host saying "not tonight" is useful casually, and an organizer saying it is useful in a tournament.

---

## How to read this

Each phase declares **Deliverables** (what exists at the end), **Exit criteria** (how you know it is done, stated as things that either pass or do not), and **Do not build yet** (the scope guard). Phases are sequential in dependency, not necessarily in calendar time; Phase 4 can start against a mocked transport once Phase 3's protocol is frozen.

Estimates are in focused working days for one experienced engineer with an agentic coding assistant. They assume the gap register is closed, which is the single largest determinant of whether these numbers hold.

The build order follows §14 of the spec. The additions are Phase 0, the split of the client phase's trust boundary, and explicit exit criteria that a reviewer can check without reading the code.

---

## Phase 0 — Spec reconciliation — **CLOSED (2026-07-28)**

**Effort:** 0.5 day. **Blocks:** everything.

The spec was marked "Accepted, ready to build." It was close, but four items (G1–G4) were load-bearing rules that no engineer could implement without guessing, and guessing wrong means rewriting the reducer.

### Delivered

- **D10–D13** appended to spec §2 — privilege sequence, round-2 `CHOOSE` removal, self-duplicate prohibition, forced final selection
- §9.1 round loop rewritten. `skip` retired and split into `remove` (decisions) and `forcedSelect` (state transitions)
- §5 gains `SlotIdx`, `Slot.index`, and `Ruleset.constraints: DraftConstraints`
- §6 `legalDraftPool` is now slot-indexed and carries the D12 term as set algebra
- §10 gains a per-round `advantageHolder` assignment table — round 2's was previously undefined in practice
- §13 gains a fifth validator (_transition preservation_) and the roster floor is derived rather than asserted
- §3 gains **O5** — a strategic consequence of D10, see below
- `SPEC-GAPS.md` carries a status board and per-item resolution notes

### Round two — D14 through D19

| #                  | Landed                                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G11 → D14**      | `roster/roster.json` shipped with 10 placeholders; `roster/README.md` documents replacement. `status: RETIRED` instead of deletion, so replay never breaks                                                                    |
| **G12 → D15**      | Either seat reports, no confirm, `UNDO_LAST_RESULT` until the next roll. ~~Two-sided capability **withdrawn**~~ — **reinstated for tournament matches by D38**; D15 stands unchanged for casual play                          |
| **G13 → D16**      | `engineVersion` in the creation event, replay refuses on major mismatch, `EventEnvelope` written out in §5                                                                                                                    |
| **G6 → D17**       | Seat token in `localStorage` + resume link. Full `project()` resync on reconnect. No clocks, 7-day idle expiry, no withdrawal of sealed commits, no forfeit                                                                   |
| **G5 → D18**       | `@banpick/types` (client) / `@banpick/engine` (DO only), enforced in CI                                                                                                                                                       |
| **G8 → D19**       | ~~**No tournament layer, permanently.** Phase 7 deleted.~~ **Reversed by D37 (2026-08-15)** — see [`TOURNAMENT-PLAN.md`](TOURNAMENT-PLAN.md). `tournamentBanned` → `globalBanned` stands: both a host and an organizer set it |
| **G14**            | Sixth load-time validator: `(scoring, resolution, overtime)` must provably terminate                                                                                                                                          |
| **G7 → D20**       | URL hash cut — it guarded a scenario the snapshot already covers. `modeContentHash` in the creation event instead                                                                                                             |
| **G10 → D21**      | `HALF_POINT` only. `COMPENSATION`, `ROLL_OFF`, `VOID_AND_REPLAY` cut. Takes the whole `advantageHolder` apparatus with it                                                                                                     |
| **G9 → D22 / D25** | **4 drafted slots by default**, and `draftCount` is a declared mode parameter (values `[3, 4]`) the host picks in the lobby. One mode file. Roster floor becomes `draftCount + 1`                                             |
| **D26**            | `SELECT` auto-commits when exactly one legal option exists. Supersedes D13's round-2 special case and removes every conditional from mode config                                                                              |
| **D23, D24**       | `TURN_ORDER` = the right to _decide_ play order, exercised after both picks are revealed                                                                                                                                      |

### Phase 0 is CLOSED — Phase 1 is open

Every gap G1–G14 is resolved. D10–D24 carry the decisions.

**One new open item, O6:** the roster target moving to ~75 makes the `bring-ban1` meta ban nearly blind (`4/75 ≈ 5.3%` hit rate under uniform drafting). It does not gate the engine, which is indifferent to roster size, but it changes what the mode _is_ — the ban becomes a read on the person rather than the draft. Resolve before Phase 4 writes UI copy.

### Exit criteria

- Zero items in the register carry the **Blocking** label without a resolution ✔
- The `base` mode YAML in §9.1 can be traced by hand through three rounds with no branch where a reader must choose an interpretation ✔

### Do not build yet

No code exists in this repository. Resist the temptation to start the engine "while thinking about" the rules — the rules _are_ the engine.

---

## Phase 1 — Engine package (`@banpick/engine`)

**Effort:** 4–6 days. **Depends on:** Phase 0.

The pure core. No network, no framework, no clock, no `Math.random`. This is the phase where the whole design either proves itself or does not, so it gets the most test weight of any phase in the plan.

### Deliverables

**1.1 Type layer** — split into a separate publishable package `@banpick/types` from day one (D18). Contains `Seat`, `CharId`, `Slot`, `Slice<T>`, `Ruleset`, `MatchState`, `EventEnvelope`, `Action`, `PlayerView`, and the wire serialization. The client will import this and nothing else, ever.

**1.2 Deterministic RNG** — seeded once per match from the creation event (§11 non-negotiable 1). Use a counter-based generator (PCG or xoshiro) keyed by `(seed, eventIndex)` rather than a stateful stream, so a replay can evaluate any single roll without replaying the ones before it. This is a small choice that makes the Phase 5 log analysis dramatically easier.

**1.3 Pool grammar** — the five expressions in §6 implemented as composable set operations over tagged sets, not as five hand-written functions. The test that this was done correctly: adding D12's `selfDuplicates` constraint should be a new term in an expression, not a new `if`.

**1.4 Phase modules** — the nine modules in §8 as data-driven reducers, each declaring its read set and write set as metadata (the loader in Phase 2 consumes that metadata).

**1.5 Engine surface** — `reduce`, `legalActions`, `project`. Pure, total, and non-throwing: an illegal event returns a rejection value, it does not throw. Throwing reducers and event sourcing are a bad marriage.

**1.6 Modes in code** — `base` and `bring-ban1` constructed programmatically, each at **both** `draftCount` values. They move to YAML in Phase 2.

**1.7 Auto-commit (D26)** — `SELECT` resolves itself when exactly one legal option exists. Test it at `draftCount: 3`, where it fires in both round 1 and round 2; at `draftCount: 4` it should never fire in the base mode, and a test should assert that too.

### Test gates (these are the deliverable, not an afterthought)

| Test                         | Asserts                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Golden replay                | A scripted event list plays `base` to a terminal state; the final `MatchState` matches a checked-in fixture byte for byte. Run at **both** `draftCount` values (D25)                                                                                                                                     |
| Golden replay, hidden mode   | Same for `bring-ban1`, including both reveal gates and a triggered repick                                                                                                                                                                                                                                |
| Redaction (§7, **required**) | After gate one, the serialized `project(state, 'A')` payload contains B's meta ban and **zero** of B's character IDs. Assert on the serialized string, not the object — an object test passes while a `toJSON` leaks                                                                                     |
| Redaction, negative          | The same assertion before gate one: A's payload contains neither B's ban nor B's picks                                                                                                                                                                                                                   |
| Determinism                  | The same event list replayed 100× produces an identical state hash                                                                                                                                                                                                                                       |
| Purity                       | `reduce` does not mutate its input (deep-freeze the input in tests); a lint rule bans `fs`, `crypto.randomUUID`, `Date`, and `Math.random` imports in the package                                                                                                                                        |
| Legality soundness           | For every reachable state in a fuzzed corpus, every action in `legalActions()` is accepted by `reduce`, and a sample of actions outside it is rejected                                                                                                                                                   |
| Draw termination             | Three consecutive tied rounds terminate at **1.5–1.5, a legal drawn match** (D21), with no unconsumed-slot invariant violation. Separately: a 2–0 after two rounds fires `stopWhenDecided`, and a 1.5–0.5 does not. _(Rewritten — the original named `COMPENSATION` and `FIRST_TO_2`, both cut by D21.)_ |
| O1 asymmetry (§14.1)         | An explicit test encoding the current round-1 privilege strength, written so that a future balance fix visibly changes its expected value                                                                                                                                                                |

### Exit criteria

- Both modes play to a terminal state from scripted events
- Branch coverage on `legalActions` and `project` is 100%; line coverage on the package is ≥90%
- The package's `dependencies` field is empty
- The redaction test fails if you deliberately remove one line from `project`

### Do not build yet

No YAML parsing. No WebSockets. No UI. No persistence. If a task in this phase requires reading a file, it belongs to Phase 2.

---

## Phase 2 — Format loader and validators — **CLOSED (2026-07-28)**

**Effort:** 2–3 days. **Depends on:** Phase 1.

Turns modes from code into config. The point of the whole architecture (§1: "New modes must be config, never engine code") is unproven until this phase closes.

**It closed, and the bet paid.** `modes/base.yaml` and `modes/bring-ban1.yaml` resolve to programs byte-identical to Phase 1's hand-built ones, at both `draftCount` values, with zero engine changes required to express them.

### Findings

| #      | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1** | **§13's transition-preservation validator, as worded, rejects the shipped base mode.** "`remove` may not name a module that writes a state slice" — but `BAN` writes `bannedInRound`, and round 2 removes `BAN` because round 2 has no ban (D11). Nothing is left un-transitioned. The property that actually distinguishes D13's bug is _"the round cannot complete without it"_, which each module now declares as `essential`. `SELECT` spends a slot; `REPORT_RESULT` produces the result the match rule scores |
| **F2** | **`remove` must name module ids, never types.** §9.1 writes round 2's override as `remove: [CHOOSE, BAN]`, but the template holds **two** CHOOSE modules — the privilege choice and D24's `declareOrder`. Removing by type deletes the wrong one and silently drops the play-order decision from the final round. The schema now requires an id on every module                                                                                                                                                     |
| **F3** | **The termination validator is unreachable through YAML**, because the schema pins `scoring`, `resolution`, and `overtime.enabled` to single values — the only document it accepts is the terminating one. That is defence in depth rather than a gap, and the validator is tested at its own level instead of through a fixture the schema would reject first                                                                                                                                                      |
| **F4** | **The roster-viability validator has to run twice.** At load time `globalBanned` is empty, because the host has not chosen yet, so it can only check the roster alone supports the mode. **The lobby must re-check with the host's actual bans before `SEAT_FILLED`** — a host can ban a match into unplayability that no load-time check could have seen. Carried into Phase 3                                                                                                                                     |

### Deliverables

- Schema for mode definitions (JSON Schema over the YAML), versioned
- Loader producing the same in-memory module list that Phase 1 built by hand — the acceptance test is literally that equivalence
- The validators from §13: slice dependency, roster viability, reveal reachability, transition preservation, termination
- **Parameter-space validator (D25):** every declared parameter combination passes every other validator at load time, space capped at 32 combinations. A parameterized mode validated only for its defaults is an unvalidated mode
- Canonical serialization and `modeContentHash` (D20) — sorted keys, sorted `globalBanned`, `label` excluded, SHA-256 truncated to 12 hex. It lives in the **creation event**, never in a URL; the canonical serializer itself ships in `@banpick/types` because Phase 5's replay comparison needs it too
- Failure fixture suite: one intentionally malformed mode per validator, each failing with a distinct stable error code

### Exit criteria

- `loadMode('base.yaml', { draftCount: 4 })` produces a module list deep-equal to Phase 1's hand-built equivalent, and the same holds at `draftCount: 3` ✔ _(both modes, both values)_
- Changing `draftCount` changes `modeContentHash` (D20/D25) ✔
- Every validator has at least one passing and one failing fixture ✔ _(23 fixtures; see F3 on termination)_
- A golden-hash test pins the hash of a known ruleset; changing `label` does not change it, changing `globalBanned` order does not change it, changing `rosterVersion` does ✔
- No mode file can reach the engine without passing validation — enforced structurally, not by convention ✔ **for files**: the loader is the only thing in the repo that parses mode YAML, and it validates everything before returning anything, so there is no partially-loaded mode. Hand-building a `ResolvedMode` in code still bypasses it — that is how Phase 1 builds its fixtures, and it is covered by the engine's own tests rather than by this boundary

### Do not build yet

An editor UI for modes. Organizers editing YAML by hand is correct for v1 and probably for v2.

---

## Phase 3 — Authority runtime (Durable Object) — **CLOSED (2026-07-28)**

**Effort:** 4–5 days. **Depends on:** Phase 2, and G6 resolved.

One Durable Object per match (D8). Single-threaded execution is the reason simultaneous commits are safe; nothing in this phase may undermine that.

Tests run in **workerd** — the runtime Cloudflare deploys — rather than a Node emulation, because WebSocket hibernation, SQLite storage, and the single-threaded execution §11's whole concurrency argument rests on either behave differently outside it or do not exist.

### Findings

| #      | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **F5** | **The loader cannot run in the Durable Object.** Its schema validator compiles with `new Function`, which Workers forbid. This agrees with §13's own argument — a bad mode should fail at deploy, not mid-match — so the worker imports a build-time bundle of already-parsed, already-validated, already-hashed modes, generated by a file snapshot that fails if `modes/*.yaml` was edited without regenerating                                                                                                                                                                                                                                                                                                                                                                                |
| **F6** | **§11's request table was pessimistic.** Incoming WebSocket messages bill at **20:1**, so the real headroom on the 100,000/day request budget is roughly twenty times what the table assumed. Also missing: `rows read`, a separate 5M/day limit. It matters only in shape — state is a fold over the log, so reads are quadratic in match length. At ~35 events that is ~600 reads and irrelevant, but a longer format would want to notice                                                                                                                                                                                                                                                                                                                                                     |
| **F7** | **Coverage and the Workers pool are mutually exclusive — and it fails silently.** First recorded as "v8 reports 0% across `apps/worker/src`". The truth is worse: with coverage enabled the pool runs **zero** worker tests and prints `no tests` instead of an error, so the combined `vitest run --coverage` in `check` had been skipping all 48 worker tests — the Phase 3 exit criteria — in the CI gate. Caught 2026-07-28 by noticing `npm run check` reported 243 tests where a plain `vitest run` reported 291. `check` now runs `test` and `coverage` as separate steps; coverage stays scoped to `packages/*`, the only place it can measure anything. **The lesson generalises: a green gate that reports a test count nobody reads is a gate that can quietly stop testing things.** |

### Deliverables

- DO with WebSocket hibernation, SQLite storage backend
- Room code generation. The join URL carries the **room code and nothing else** (D20) — the joiner reads the server's immutable snapshot, so there is nothing to go stale
- Lobby state machine: created → ruleset shown to joiner → `SEAT_FILLED` → locked (§12.4). Host may abandon and reopen; never edit in place
- Event append with SQLite persistence; the event log is the record of truth and the projection is derived
- **A single outbound choke point.** Every frame leaving the DO passes through one function that calls `project()`. Not two functions. One. Grep for the WebSocket send API in CI and fail the build if it appears anywhere else
- Seat token minted at `SEAT_FILLED` (D17); `localStorage` for refresh, resume link for device change
- Reconnect: full projected resync on socket open, no deltas
- Idempotency keys on client actions — a double-clicked commit must not append twice
- Per-seat rate limiting
- Disconnect and idle policy per D17: no per-action clock, 7-day idle expiry then archive to log-only, no withdrawal of a sealed commit, and **no forfeit mechanic** — an abandoned match simply goes idle

### Exit criteria

- Two headless clients play a complete `bring-ban1` match over WebSocket ✔ _(both modes, both `draftCount` values)_
- Kill one client mid-hidden-commit, reconnect, and the match resumes with the commit intact and still sealed ✔
- Hard-refresh both clients at every phase boundary; nothing is lost and no user action is required (D17) ✔ _(refreshes **both** clients at every boundary of a whole match)_
- Open the resume link in a different browser; the seat is recovered with correct redaction ✔
- Both seats clicking ready within the same millisecond produces one reveal, not two — tested by forcing concurrent requests, not by assuming the runtime ✔ _(both frames sent before either is processed; asserts exactly one commit each, exactly one reveal, and a dense `seq` sequence)_
- The §7 redaction assertion runs against the _real serialized frame_ off the wire, not a unit-test object ✔ _(every frame the client received, not just the last)_
- Free-plan headroom re-verified against current Cloudflare limits ✔ — every row held; see **F6** for two corrections, both in our favour
- A full match consumes fewer than 500 DO requests ✔ — **~60 measured**, counting HTTP, inbound messages, and outbound frames, before the 20:1 WebSocket discount applies

### Do not build yet

Accounts, auth, or persistence of anything beyond the match itself. Room code plus seat claim is the entire identity model for v1.

---

## Phase 4 — Client — **CLOSED (2026-07-28)**

**Effort:** 4–6 days. **Depends on:** Phase 3's protocol frozen (can start against a mock).

Deliberately thin (§14.4). The client's job is to render `PlayerView` and post actions. It has no opinions about rules.

### Deliverables

- Lobby: create match (mode + **its parameters** + global ban list), join by code, **ruleset fully rendered before seating** (§12.3 — seating is consent, so the render must be complete, not a summary, and it must show parameter values: a host quietly switching 4 picks to 3 is exactly the change being consented to)
- **Draft UI at scale.** Picking 4 from ~75 is a search-and-filter problem, not a grid. Text search, favourites, and recents are requirements, not polish (O6)
- Match view: slot rail with consumed/banned states, hidden-commit UI with an explicit "sealed" affordance, reveal treatment at both gates
- Turn-order declaration step after both picks reveal (D24), with `SELF_FIRST` / `OPPONENT_FIRST` framed as a real choice
- **Draw state.** At a 5% per-round tie rate, ~7% of matches end 1.5–1.5 (D21). Design it, do not bolt it on
- Action rendering driven exclusively by the server's `legalActions` list
- Reconnect banner and resync
- UI copy for `bring-ban1` — **rewritten for O6.** At 75 characters the honest framing is "what do they always play?", not "did they bring this?" The §9.2 note as written describes a mode that only exists at small roster sizes
- ~~Deployed to Cloudflare Pages on the same account~~ — **served by the Worker instead**, see F8

### Findings

| #       | Finding                                                                                                                                                                                                                                                                                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F8**  | **The client ships as Worker static assets, not Cloudflare Pages.** §11 predates Workers Assets. The deciding factor is **same origin**: the Worker mints the resume link and the WebSocket URL from the request origin (D17/D20), so a split origin would buy CORS on every lobby call and a cross-origin socket in exchange for nothing. One `wrangler deploy` ships both halves |
| **F9**  | **`apps/*` was never being typechecked.** The root tsconfig's `include` covered `packages/*` only, so all of Phase 3 compiled solely through the bundler. Widening it surfaced five real errors — including a `Cloudflare.Env` vs global `Env` mismatch that silently typed every test's bindings as `{}`. Now included, and clean                                                 |
| **F10** | **Static asset serving is not testable through the Workers pool.** It wires the `assets` _binding_ but does not serve assets, so `/` and the SPA fallback 404 under test while working under `wrangler dev`. Verified manually instead (see below); what remains automated is that `/api/*` still reaches the Worker, which is the half a code change could break                  |

### Exit criteria

- Two humans play a full match in two browsers on two devices — **not automated; needs you.** Everything under it is verified: two headless clients play complete matches over WebSocket (Phase 3), and the lobby flow was driven end to end against `wrangler dev`
- CI dependency rule proves the client imports `@banpick/types` and never `@banpick/engine` (G5) ✔ — and observed failing on a deliberate violation in `apps/web`
- Disabling JavaScript-side validation entirely changes nothing about which actions succeed ✔ — **there is none to disable.** 14 tests assert that every control is a rendering of a `legalActions` entry: remove the entry and the control goes with it
- ~~Usable at 390px width~~ — **struck 2026-07-31. The app is desktop-first.** This was true when the client was a stack of lists. It stopped being true when the board became a fixed arena: `Stage` positions cells absolutely on a 132px pitch, which makes the board 1152px wide at `draftCount: 4` and gave it no media query at all — it overflowed a 390px phone by roughly 760px. Offered as a bug to fix; the owner chose the descope, because reflowing the board onto a phone means a second layout to maintain and the game is being played on laptops. Recorded here rather than left quietly failing, which is the only version of this that is honest. The board now scales as a whole below its natural width so a small laptop or a half-width window still works

### Do not build yet

~~Animations beyond the reveal gates.~~ — **built in Phase 4.5, deliberately.** Spectator mode. Theming.

---

## Phase 4.5 — Cosmetic upgrade — **CLOSED (2026-07-29)**

**Effort:** 1 day. **Depends on:** Phase 4. **Not in the original plan** — requested after playing the Phase 4 client, which is the right reason for a phase to exist.

Phase 4 said "do not build animations yet." This builds them. The deferral was correct at the time: an animation over an unfinished protocol is wasted work. It stopped being correct once the thing was playable and the gaps were observable rather than theoretical.

Three asks, and each turned out to need a change **below** the client.

### Deliverables

- **Hero art and a grid.** 45 heroes as a multicolumn grid of portraits rather than a list. `scripts/fetch-hero-art.mjs` fetches once from the publisher's index, honouring `Crawl-delay: 10`; see `roster/README.md` for what it does deliberately and for the licensing position
- **The roll as a reveal.** `DiceRoll` plays each throw: tumble, land, hold — and on a tie, name it and roll again. Honours `prefers-reduced-motion` by skipping to the result
- **Opponent progress.** `OpponentActivity` shows what the opponent is doing and, during a hidden draft, how many slots they have filled
- **A shared draft board.** Both rails stay on screen for the whole match, sized from `draftCount` before anyone commits. Slots fill live as each side picks — face up for you, face down for them — and flip over, staggered, at the mode's reveal point. Requested after playing: the draft happened behind a blank screen and four slots appeared at once at the end

### Findings

| #       | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F11** | **The roll animation needed an event-schema change.** `ROLL` recorded `attempts: 2` but not what was thrown, so the client could only narrate "after 2 attempts" — it could not _show_ the tie. `throws: Record<Seat, number>[]` was added. A tie is ~1 in 6 at 1d6 and is the most dramatic moment in a match; a cosmetic ask reached into the event log because the data to be cosmetic about was never recorded                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **F12** | **Progress genuinely cannot be server-derived.** A draft is **one** `COMMIT` carrying every pick, so until it lands the DO knows nothing to report. Progress is therefore client-reported: `PROGRESS` → `OPPONENT_PROGRESS`, ephemeral, **count only**, never logged, never state. It is the one message in the protocol that is neither authoritative nor verifiable — acceptable precisely because it decides nothing                                                                                                                                                                                                                                                                                                                                                                                                                |
| **F13** | **A malformed create body was a 500.** Found by hand-posting `{modeId, draftCount}` (a plausible wrong shape) at `wrangler dev`: `findVariant` read a property of `undefined` and the stack trace went out over HTTP. Create is unauthenticated by design, so its body is fully untrusted. Now 400s, with `apps/worker/test/match.test.ts` covering eight malformed shapes. Unrelated to the cosmetic work; found by doing it                                                                                                                                                                                                                                                                                                                                                                                                          |
| **F17** | **An empty slice is not an absent one, and the rail conflated them.** §7 hides a slice by making it **absent**, so `slots !== undefined` looks like "you may see this". But slots start as a _public empty_ slice and only become absent when a commit seals them — so before anyone drafts, `slots` is `[]` and visible. Keying on presence sent the rail down the revealed path with an empty array and drew **no boxes at all** for the entire draft, which is the blank screen the feature existed to remove. The rule the codebase now states in both places: **presence means readable, non-emptiness means there is something to read.** Pinned at the client (`slot-rail.test.tsx`) and at the wire (`rail-sizing.test.ts`)                                                                                                    |
| **F16** | **Progress counted decisions; slots needed slots.** `filled/of` summed picks and the meta ban, which reads fine as a sentence and is useless for drawing boxes — "3 of 5" cannot say whether that is three picks or two picks and a ban. `PROGRESS` now counts slots, with the ban as a separate flag. The general shape: a number built for prose usually cannot drive a diagram, and the fix belongs at the source rather than in a decoder at the far end                                                                                                                                                                                                                                                                                                                                                                           |
| **F15** | **The progress bar locked players out of playing.** Reported from a live match: "too many actions; slow down", stuck. `DraftPanel`'s effect listed `onProgress` in its deps and `Match` passed an inline arrow, so it fired on every render — and since a ping re-renders the _opponent_, the two clients drove each other in an unbounded loop. Progress and actions shared one token bucket, so the limiter locked the seat out of its own `COMMIT`. Fixed at three layers: a ref so the effect fires on change not on render, wire-level dedupe in the transport, and **a separate bucket for cosmetic traffic on the server** — the only one of the three that protects against an already-deployed client. The lesson is the server one: a cosmetic feature must not be able to spend the budget that playing the game depends on |
| **F14** | **The tie path had no test at all.** `throws` was added, the client animated it, and nothing anywhere exercised a reroll — the seeded RNG made it a coin flip whether any test hit one. `packages/engine/test/roll-tie.test.ts` now _searches_ for seeds that tie once, twice, and never, so the assertions cannot pass vacuously. It also pins the ~1/6 tie rate, which is what makes the feature worth having                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Exit criteria

- `npm run check` green; 330 tests across 29 files ✔
- Art is optional at every layer — a missing manifest entry **and** a failed image load both fall back to initials, so deleting `apps/web/public/art/` strips the licensed imagery without breaking the app ✔ (`apps/web/test/cosmetic.test.tsx`)
- `throws` survives engine → DO → projection → wire, agrees with the event log, and is identical for both seats ✔ (`apps/worker/test/roll-reveal.test.ts`)
- Progress relays a count, attributes the seat from the socket, clamps nonsense, appends no event, and **carries no character id** ✔ (`apps/worker/test/progress.test.ts`)
- Static assets serve under `wrangler dev` — `/art/*.png` returns 200 `image/png` ✔ (still not testable in the Workers pool, per F10)
- Two humans see the same animation on two devices — **not automated; needs you**, same as Phase 4's top criterion

### Do not build yet

Sound. Per-hero colour theming. Animating anything that is not a reveal of something the server already decided — that direction ends in a client with an opinion, which D18 exists to prevent.

---

## Phase 5 — Event log export and instrumentation

**Effort:** 2 days. **Depends on:** Phase 4 shipped to real players.

§14.5 is right that this is what turns the app from a toy into a balance instrument. It is listed last and it is the most valuable deliverable in the plan, which is worth noticing.

### Deliverables

- NDJSON export per match, one event per line, including seed and ruleset snapshot
- Offline analysis script computing the five §15 metrics
- The falsifiable prior and power table from spec §15 in place **before** any data is collected

### Exit criteria

- A match exported and re-imported into the pure engine replays to an identical terminal state — this is the real proof that event sourcing was implemented rather than merely intended
- The analysis script runs on a 20-match corpus and produces a directional read on O1
- A log written by engine `1.x` and replayed by engine `2.0` **refuses loudly** rather than producing a different answer (D16)
- Sample-size caveat documented per spec §15: O1 is a claim about **round 1**, and every match has exactly one round 1 — so 20 matches is **20 observations, not 60**. Treat 20 as a screening test (16+ of 20 is actionable, 12 of 20 is nothing); a 70/30 effect needs ~47 matches and a 65/35 needs ~85

### Do not build yet

A dashboard. A script that prints five numbers is the correct instrument at this scale.

---

## Phase 6 — Mode expansion (the architecture's acceptance test)

**Effort:** 1–2 days. **Depends on:** Phase 5 (data should inform which mode is worth adding).

O2 (`BAN_THEN_DRAFT`) and O3 (`MUTUAL` meta ban target).

### Deliverables

- `ban-then-draft.yaml`
- `MUTUAL` as a target option in the meta ban pool grammar
- ~~Resolution of G10~~ — **closed by D21.** `ROLL_OFF` and `VOID_AND_REPLAY` are cut, deferred rather than permanent. Reopen only if §15 shows ties above roughly 15% of rounds, and then with data rather than argument

### Exit criteria

- **Zero lines changed in `@banpick/engine`.** This is the entire point. If either mode requires an engine change, that is a finding about the module boundary, and it should be written up rather than patched over
- Both new modes pass the full Phase 1 test battery, including redaction

### Do not build yet

More modes than the data justifies. Two shipped modes with 100 logged matches beats six modes with none.

---

## Phase 7 — Tournament layer — **UNDELETED (D37, 2026-08-15)**

**Moved to its own document:** [`TOURNAMENT-PLAN.md`](TOURNAMENT-PLAN.md). Nine phases, and its
Phase 0 (the decisions D38–D42) is settled.

It lives there rather than here for a practical reason: this document spent four phases explaining
why the tournament layer would never exist, and threading a nine-phase plan back through that
would make both harder to read than either is alone. This section is the pointer, and the record
of what the deletion cost.

### What D19 deleted, and where each item now lands

~~The two affordances previously recommended for Phase 1 — a nullable `eventId` and an
organizer-resolvable `Ruleset` — are **withdrawn**. They were insurance priced against an unknown;
the unknown is now known~~ — it was assumed, not known, and both affordances are now being built
under deadline pressure rather than at leisure:

| Deleted by D19                      | Reinstated as                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| Nullable `eventId` on a match       | A `tournament: { tournamentId, slotId }` binding, snapshotted into the creation event. Plan Phase 3 |
| Organizer-resolvable `Ruleset`      | Tournament-owned rulesets; the room opener cannot override them. Plan Phases 2–3                    |
| Two-sided `REPORT_RESULT` (via D15) | **D38**, for tournament matches only. Plan Phase 4                                                  |

~~Room code plus seat token is the permanent identity model, not a provisional one.~~ **D41** adds
a per-tournament entrant token beside the seat token. Still not accounts, still nothing that
crosses devices except a link — D19's identity model survives its own reversal, which is the part
of it that was actually right.

---

## Cross-cutting

### Day-one setup (not spec gaps, but genuinely pre-implementation)

None of these are hard, and all of them are annoying to change at Phase 3. Decide them once, in an hour, before Phase 1:

- **Repo layout.** Monorepo with `packages/types`, `packages/engine`, `packages/loader`, `apps/worker`, `apps/web`. The G5 package split is structural, so the layout must exist before the first file does.
- **Toolchain.** Package manager, TypeScript config (strict, `exactOptionalPropertyTypes` on — this is a discriminated-union-heavy codebase and it will earn its keep), test runner, formatter.
- **CI from commit one.** Three checks that must exist before there is code to check: the dependency rule enforcing G5, the no-IO lint rule on `packages/engine`, and coverage thresholds. Adding these later means fixing violations rather than preventing them.
- ~~**Fixture roster.**~~ Done — `roster/roster.json` holds ten placeholders (D14). **Add a synthetic 75-entry fixture too**, so Phase 1 and Phase 4 both exercise the real target scale (O6).

### Definition of done, every phase

Tests written and passing in CI; the exit criteria checked by someone other than the author, or by a checklist run deliberately; the spec amended if the phase revealed the spec was wrong; no `TODO` that a later phase depends on without a register entry.

### Risk register

| Risk                                                       | Phase | Signal it is materializing                                              | Response                                                                                                                                                                              |
| ---------------------------------------------------------- | ----- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module boundary is wrong — a new mode needs engine changes | 6     | O2 cannot be expressed in YAML                                          | Do not patch. Write up which slice the module system cannot express; that is the real spec bug                                                                                        |
| Redaction leak via serialization                           | 1, 3  | Redaction test passes on objects but a wire capture shows character IDs | Assert on serialized strings at both layers; never trust a `toJSON`                                                                                                                   |
| Cloudflare free-plan limits shift                          | 3     | Any §11 table row no longer matches current published limits            | Recheck at Phase 3 start; the headroom is ~200× so a change is unlikely to be fatal                                                                                                   |
| O1 balance flaw is real and large                          | 5     | Round-1 privilege holder wins well above the 65% prior                  | The draft-4 fix in O1 is a config change, not an engine change — verify that claim in Phase 2, not Phase 5                                                                            |
| ~~Scope creeps toward tournaments~~                        | —     | ~~"While we're in here, let's just add brackets"~~                      | **Retired by D37.** Brackets are in scope and planned; the guard against creep now lives in `TOURNAMENT-PLAN.md`'s _Not building_ section, scoped to formats rather than to the layer |

### Sequencing note

The critical path is 0 → 1 → 2 → 3 → 4 → 5. Roughly 17–24 focused days. Phase 4 can overlap Phase 3 by two or three days once the protocol is frozen, which is the only meaningful parallelism available to a single engineer and is worth taking.

The deeper reason to hold this order: Phases 1 and 2 are where the design's central bet — that modes are data — either pays or does not. Building the transport or the UI first would let you ship something playable while leaving that bet untested, and the spec's whole value is that it made the bet explicit.
