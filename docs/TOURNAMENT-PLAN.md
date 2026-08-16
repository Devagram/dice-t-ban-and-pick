# Tournament layer — build plan

**Status:** **built — Phases 0–8, plus a Phase 9 the plan did not have (2026-08-16).** Read each phase's _Deviations_ and _Found while building_ before changing anything in it; several of them exist because the first answer was wrong. Phase 9 is the plan's own blind spot: eight phases and no way for anyone to create a tournament.
**Reverses:** D19 ("no tournament layer, permanently"). See _What D19 took with it_ below before starting.
**Companion docs:** [`DELIVERY-PLAN.md`](DELIVERY-PLAN.md) (Phase 7 was deleted, not deferred), [`SPEC-GAPS.md`](SPEC-GAPS.md) G8.

---

## Read this first

**This reverses a settled decision, and that is not a formality.** D19 did not defer the tournament layer, it deleted it — and the codebase then took real advantage of the deletion. `banpick-design-spec.md` §17 says "there will be no tournament layer. No events, no organizers, no brackets." The risk table in the delivery plan lists "scope creeps toward tournaments" as a named risk whose mitigation is _"the answer is no, not later — and the design is now cheaper because the answer is no."_

That cheapness has to be paid back. The plan below is honest about where.

Adopting this plan means writing **D37 — the tournament layer, reinstated**, appending it to the spec's decision table, and striking §17's paragraph rather than leaving it to be discovered as a contradiction later. Do that in Phase 0, not at the end.

### What D19 took with it, and what has to come back

| Removed by D19                                                                                                                                                         | Why it matters again                                                                                                                                                     | Phase |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| **Two-sided result reporting.** SPEC-GAPS: _"withdrawn — it existed solely to survive a tournament retrofit."_ D15 ships one-sided, no confirm.                        | A bracket advances on a result **either player can report alone and either player can undo alone**. Fine between friends; not fine when it decides who is eliminated.    | 4     |
| **Organizer-owned rulesets.** SPEC-GAPS G8: _"model `Ruleset` as resolvable from an event, not only from host input"_ — recommended, never landed because D19 said no. | A tournament match's ruleset comes from the bracket, and the player who opens the room must not be able to change it. Today the host chooses everything at `/api/match`. | 3     |
| **Any event entity at all.** No organizer role, no bracket, no match provisioning.                                                                                     | All of it is this plan.                                                                                                                                                  | 1–3   |
| **`tournamentBanned`** → renamed `globalBanned` (D5).                                                                                                                  | Keep the name. It is host-set _and_ organizer-set now; the mechanism never cared. Renaming it back would churn every file for nothing.                                   | —     |

Two further things D19 never anticipated, both landed since, both of which the tournament layer now has to survive:

- **D33's in-match amendment and D34's admin edit** can change a completed match's result _after_ the bracket has consumed it. Phase 4.
- **D35's duplicate player ids.** A player id belongs to a browser. An entrant who opens the tournament on their phone is a different person as far as the bracket is concerned. Phase 3.

---

## Architecture at a glance

```
packages/bracket/     @banpick/bracket   — NEW. Pure: seeding, advancement, format rules. No IO, no clock.
apps/worker/
  TournamentDO.ts                        — NEW. One per tournament. Authority for the bracket.
  MatchDO.ts                             — gains an optional tournament binding + assigned seats
  RegistryDO.ts                          — gains a tournament index (list, lookup)
apps/web/
  screens/Tournament.tsx                 — NEW. The bracket, live.
  components/Bracket.tsx                 — NEW. The graphic.
```

**The load-bearing choice: the bracket is a pure function, exactly like the engine.** `advance(bracket, results) → bracket` with no IO, no clock, and seeded randomness only. `TournamentDO` is an authority wrapper around it — it owns storage, sockets, and match provisioning, and holds no bracket logic of its own.

This is not symmetry for its own sake. It buys the same four things `@banpick/engine` bought:

1. **Replay.** A tournament is a log of results; the bracket is a fold over it. A disputed advancement can be recomputed from the log rather than argued about.
2. **Testability under Node**, at the coverage bar the engine holds (100% branch on the routing functions), instead of only inside workerd.
3. **A boundary CI can enforce.** `scripts/check-boundaries.mjs` gets a fourth rule: `@banpick/bracket` may be imported by the worker and nothing else.
4. **No clock, no random.** Double-elimination routing is fiddly enough without nondeterminism in it. Seeding randomness takes a seed from the creation event, like the dice (§11, D16).

---

## Phase 0 — Decisions — **SETTLED (2026-08-15)**

All five were answered by the owner. They are recorded below as **D38–D42** with their
consequences worked into the later phases, so no phase carries a conditional branch waiting on an
answer that has already been given.

**Doc reconciliation — done 2026-08-15.**

- [x] **D37 written** into `banpick-design-spec.md` §2, and **§17 struck**. The original argument is kept under a superseded banner rather than deleted: it turned out to be an accurate invoice for what a tournament layer costs, and every simplification it lists is now a line item the plan pays. What it got wrong was the word _permanently_, not the reasoning.
- [x] **D38–D42 appended** to the same table with their reasoning.
- [x] **`SPEC-GAPS.md` G8** → REOPENED, pointing here. Its downstream-simplifications list is annotated with where each item now lands.
- [x] **The "scope creeps toward tournaments" risk row retired** in `DELIVERY-PLAN.md`. The guard against creep now lives in this document's _Not building_ section, scoped to formats rather than to the layer.
- [x] **The "two-sided capability withdrawn" line struck** in both `DELIVERY-PLAN.md`'s D15 row and `SPEC-GAPS.md` G12, noting that the withdrawal treated "two-sided" as a property of the app when it is a property of the _match_.
- [x] **`DELIVERY-PLAN.md`'s Phase 7 undeleted**, pointing here, with a table of what D19 deleted and where each item lands.

**Found while doing it, and fixed:**

- [x] **The spec's decision table had drifted six decisions behind.** It stopped at D30 while D31–D36 (the open lobby, rematches, in-match amendment, history and admin, duplicate player ids, and the Bo1) lived only in code comments and the README. A table headed "closed decisions" that is missing six of them is the exact failure it exists to prevent, so they are backfilled — at table depth, with the code comments left as the long form.

### D38 — both seats confirm a tournament result

**Reinstates what D15 withdrew**, and the withdrawal said so explicitly: _"it existed solely to
survive a tournament retrofit, and D19 rules that out."_ That sentence is now the argument for
undoing it.

One-sided reporting stays for casual matches — it is right there, and D15's reasoning about
friends is untouched. The two-sided rule applies to a match that carries a `tournament` binding,
which is a property of the match rather than a mode of the app.

- **A disagreement produces a `DISPUTED` slot**, halting that branch and surfacing to the organizer. Deliberately not a resolution rule the app invents: two people who disagree about who won are not a case an algorithm should adjudicate.
- The rest of the bracket carries on. One disputed semi-final must not freeze the other half.

### D39 — a consumed result freezes; only the organizer cascades

Once a result advances a bracket slot it is **consumed**, and from that moment:

- Players' `UNDO_LAST_RESULT` and D33 amendment are closed on that match, and the UI says so and says why. A control that silently stops working is worse than one that explains itself.
- Only the organizer can change it, and doing so **re-derives the bracket from the corrected result log** rather than patching the current state.
- Downstream matches not yet played are invalidated automatically. Downstream matches **already played** are never silently rewritten — they are listed for the organizer to void or keep, because whether a game that really happened still counts is a judgement about the evening, not about the data.

### D40 — grand finals offer bracket reset, defaulting to on

Both are configurable per tournament; **reset is the default**. It is the standard rule and it is
the thing that makes double elimination fair — the losers-bracket winner arrives with one loss and
should have to inflict two.

A reset match is just another slot to `@banpick/bracket`, so this costs one flag rather than a
special case. The mode config can override `GRAND_FINAL_RESET` separately from `GRAND_FINAL`.

### D41 — entrant tokens, and the organizer may re-link

**Both**, and they solve different halves of the same problem:

- **A per-tournament entrant token**, minted at entry and carried in the join link, exactly as D17 mints a seat token. Playing from a second device is then a link, not a plea. Kept in `localStorage` like every other credential here, with the same §17 trade: losing the browser loses it.
- **The organizer can reassign an entrant's player id mid-tournament**, reusing D35's merge machinery. Which is the answer when the token _is_ lost, and the reason the token alone is not enough.

The two together mean an entrant is identified by the token in practice and by an id the organizer
can correct in the last resort — neither of which is an account, so D19's identity model stands.

### D42 — 32 entrants, and a tournament lives a week

- **Cap: 32 entrants**, stated and enforced at creation. `RegistryDO` already carries the note that a single Durable Object serialises every write, that this is right at twelve players and wrong at thousands, and that _"this comment is the warning that nobody did"_ shard it. A tournament object has exactly the same shape and gets exactly the same warning, in the file.
- **Tournament TTL: 7 days** from the last activity, then swept.

**The casual lobby's `ROOM_TTL_MS` stays at 2 hours.** These are two different questions wearing
one word. A room in the open lobby list is an invitation, and a two-hour sweep exists because
_"a lobby full of dead rooms is worse than an empty one — every entry is a click that goes
nowhere."_ A tournament is a commitment that spans evenings. So:

- [ ] `TOURNAMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000`, in `TournamentDO`
- [ ] Rooms provisioned **by a tournament** inherit the tournament's lifetime rather than the lobby's 2 hours — they are not lobby invitations and are excluded from that list anyway (Phase 3)
- [ ] Leave `ROOM_TTL_MS` alone, and add a comment at each pointing at the other, so the next reader does not "fix" the inconsistency

---

## Phase 1 — `@banpick/bracket`, the pure package — **DONE (2026-08-15)**

**Deliverable:** a package that can compute an entire tournament from a list of entrants and a list of results, with no IO of any kind. 49 tests, `advance.ts` and `derive.ts` at 100% branch.

### Scaffolding

- [x] `packages/bracket/` with `package.json`, matching the shape of `packages/engine`. No `tsconfig.json` of its own — the engine has none either; the root config's `paths` and `include` cover both.
- [x] Added to the root `tsconfig.json` paths and picked up by `vitest.config.ts`'s existing `packages/*/test/**` glob
- [x] **No-IO lint** extended to `packages/bracket/src` — the same rule object, with its messages generalised from "packages/engine is pure" to cover both
- [x] **Boundary rule** in `scripts/check-boundaries.mjs`, generalised from one hardcoded package to a `RESTRICTED` list. Manifest **and** source, as before. Consumers: `packages/bracket`, `apps/worker`.
      **The reason differs from D18's and the comment says so:** nothing about a bracket is secret — the graphic renders the whole thing. The rule is about _authority_. A client holding `advance` would eventually predict a result optimistically, and an optimistic bracket disagreeing with the server is precisely the two-truths failure D39 exists to prevent.

### Types

- [x] `BracketFormat`, `Entrant`, `Ref`, `Slot`, `ResultEntry`, `BracketState`, `SlotView`
- [x] `SlotId` derived from the shape: `W1M2`, `L3M1`, `GF`, `GF2`
- [x] `SlotStatus` — **`LIVE` deliberately dropped from the plan's list.** "A room exists and two people are in it" is a fact about a match, not a bracket, and this package cannot know it without importing what it is defined not to know. `TournamentDO` overlays it in Phase 5. Including it would have meant a value nothing here can return.
- [x] `BracketState` also carries `finalSlotId`, which the plan did not anticipate — see the bug below.

### The functions

- [x] `buildBracket` — pure, total, deterministic given `seedingSeed`
- [x] **Byes** land on the top seeds by construction rather than by a rule: `seedOrder` pairs seed 1 with the weakest position, and the weakest positions are exactly the ones nobody filled. A walkover resolves with **no result entry** — recording one would make it indistinguishable in the log from a game somebody played.
- [x] **Seeding modes** `AS_ENTERED` (default), `RANDOM` (seeded, reproducible), `MANUAL` (validated, refuses duplicates and out-of-range)
- [x] `advance`, `dispute`, `voidSlot`, `applyResult(s)`, `rederive`, `downstreamOf`
- [x] `readySlots`, `statusOf`, `viewOf`, `views`, `champion`, `isComplete`, `lossesOf`, `isEliminated`
- [x] **Double-elimination loser routing**, written out with the round table in the source comment. `2(k-1)` rounds alternating minor/major; `L(2i-1)` and `L(2i)` each hold `2^(k-i-1)` matches.
      **Anti-rematch:** major rounds take their drop-ins reversed. **Honest limit, recorded in the code:** this is one convention, and at 16 and 32 a rematch remains _possible_ several rounds deep for some result sequences. Eliminating those needs a published per-size placement table, and inventing one that looks plausible would be worse than a documented simple rule. Guaranteed and tested instead: two losses to eliminate, one champion, termination, and no rematch in the first major round.
- [x] **D40 — bracket reset.** `GF2` is in the structure from the start and reachable only when the losers-bracket entrant wins `GF`. Terminal by construction.
- [x] **D39 — `voidSlot` and `rederive`.** The log is append-only and last-write-wins, so a correction is an append and the earlier answer stays readable.
- [x] **D38 — `DISPUTE` is a first-class result** that resolves nobody. Routing treats it identically to `VOID`; only `statusOf` distinguishes them, so a disputed branch cannot advance anyone.

### Test gates

- [x] **100% branch/line/statement/function** on `advance.ts` and `derive.ts`, added to `vitest.config.ts` thresholds beside `legalActions` and `project`
- [x] **Purity** — no mutation, byte-identical output for identical input, reproducible seeded draws
- [x] **Known-good structures** for 4, 8, 16, 32, hand-written rather than snapshotted
- [x] **Every entrant count 2–32** — everyone appears exactly once in round one, byes to the top seeds, exactly one champion
- [x] **Nobody eliminated on fewer than two losses** — exhaustive over _every_ result sequence at N=4 and N=8 (2^15 terminal states), not a sample
- [x] **Termination**, including `grandFinalReset: true`
- [x] **D40 both ways**, **D39 fold equality at every correction point**, **D38 dispute isolation**

### Found while building

- [x] **A real routing bug, caught by the N=4 exhaustive sweep.** In double elimination the winners final kept `winnerTo: null` — correct for single elimination, where that slot ends the tournament, and wrong here. It made the winners final a second candidate for "the slot that decides this", and a champion was crowned while the losers bracket was still playing. Fixed by routing it to `GF`, **and** by replacing the inference with `finalSlotId` recorded at build time: an inference that can pick the wrong slot is worth replacing with a statement that cannot.
- [x] **Two unreachable branches removed rather than tolerated.** `winnerOccupant` tested each side for a bye in turn, which left a case no valid bracket reaches (side `b` a bye while side `a` is unknown — seeding puts the smaller seed of every pair first, so a first-round bye is always on `b` with a real entrant opposite). Rewritten symmetrically. `slotById` now throws instead of returning null, because a ref naming a missing slot is a build bug rather than a state. `project.ts` already made this argument: a branch no state can reach reads as a case somebody handled.

**Exit criteria**

- [x] `npm run check` green with the new package in it — 734 tests, boundaries, coverage thresholds
- [x] A full 8-entrant double-elimination tournament played out in a unit test with no worker, no DO, and no network — `test/exit-criteria.test.ts`, written to be readable end to end by someone who knows nothing about the rest of the repo

**Do not build yet:** anything that knows a match exists. This package must not import `@banpick/engine` or `@banpick/types`' match state. It deals in entrants and results, not in dice. _(Held: `packages/bracket/package.json` declares no dependencies at all.)_

---

## Phase 2 — `TournamentDO` — **DONE (2026-08-15)**

**Deliverable:** a tournament exists, persists, and can be read. It provisions no matches yet. 19 worker tests in workerd.

- [x] `apps/worker/src/TournamentDO.ts` — one object per tournament, named by its code
- [x] **Codes are prefixed `T-`**, sharing the room-code alphabet and length. The recommendation held: the router should never have to guess which kind of code it is holding, and a string valid as both is a bug waiting for somebody to paste one into the wrong box and land in a stranger's match instead of a 404.
- [x] **`wrangler.jsonc`: binding plus a `v4` migration** with `new_sqlite_classes: ["TournamentDO"]`. No applied tag edited.
- [x] SQLite schema: `tournament`, `entrants`, `results` (append-only, `AUTOINCREMENT` ordered), `provisioned`
- [x] **D42 — the 32-entrant cap enforced at creation**, twice over: once in `parseEntrants` for a named 400, and once inside `buildBracket` so the package cannot be misused from anywhere else. `RegistryDO`'s scale warning carried across in full.
- [x] **D42 — `TOURNAMENT_TTL_MS = 7 days`**, and the cross-reference comment added to `ROOM_TTL_MS`
- [x] **D41 — an entrant token per entrant**, minted at creation and returned **once**
- [x] **Rulesets snapshotted at creation** (§11 non-negotiable 2) — every position resolved to a validated variant with its `modeContentHash`, stored as JSON on the row
- [x] Bracket state **derived on read**, never stored: `buildBracket` from the entrant rows, then `rederive` over the result log
- [x] `POST /api/tournament` — create, with the same collision-retry shape as `createMatch`
- [x] `GET /api/tournament/:code` — public read

### The mode configuration

- [x] **Default plus overrides**, keyed by bracket position
- [x] Positions: `WINNERS`, `LOSERS`, `WINNERS_FINAL`, `LOSERS_FINAL`, `GRAND_FINAL`, `GRAND_FINAL_RESET`, derived from the slot's place in the bracket rather than stored per slot — so a config written for eight people still means the same thing for nine
- [x] **D40 — `GRAND_FINAL_RESET` falls back to `GRAND_FINAL`**, and `WINNERS_FINAL`/`LOSERS_FINAL` fall back to `WINNERS`/`LOSERS` before the default. The chain is one function, `chainFor`, so the surprising case is written down in one place.
- [x] **Validated at creation**, every position, whether or not a match ever reaches it. An unknown mode id in the losers-bracket override is a 400 at creation naming `overrides/LOSERS`, not a failure at the semi-final.
- [x] `globalBanned` and D28's `allowRepeatBans` are organizer-set for the whole event and baked into every position's snapshotted ruleset — G8's "organizer-owned ruleset" affordance, landed at last

### Deviations from the plan

- [x] **Entrant tokens are stored hashed, not plainly.** The plan said to match D17, which stores seat tokens plainly. It does not: `persistence.ts` stores a hash and `identity.ts` already exports `hashToken` for it. Following the _actual_ precedent rather than the plan's description of it, so a dump of the `entrants` table is not a set of credentials. Asserted: no read ever returns a token.
- [x] **The TTL is an alarm, not a sweep-on-read.** The plan said "swept on read like the lobby's rooms are", which cannot work here — `RegistryDO` sweeps when somebody asks for the lobby list, and nothing enumerates tournaments. A Durable Object nobody fetches again would hold its rows forever. The alarm is re-armed on every write, so it measures idleness and a tournament spanning three weekends is never swept out from under itself.
- [x] **The rebuild replays seeding as `MANUAL`.** Seeds are decided once at creation and stored on the rows. Re-running `RANDOM` on every read would be reproducible — the seed is stored too — but it would make the draw _derived_ rather than _recorded_, and a re-seeded tournament is not the same tournament.

**Exit criteria**

- [x] A tournament can be created, read back, and survives DO hibernation — asserted by evicting the instance with `runInDurableObject` and reading again, so anything cached in a field is gone and the bracket must come back from storage
- [x] Creating one with an unknown mode id, an undeclared parameter combination, an unknown format or seeding mode, a nameless entrant, a duplicate player, or a field outside 2–32 fails at creation with a named error

**Do not build yet:** sockets, match creation, the UI. _(Held: `TournamentDO` has no WebSocket handler and never addresses a `MatchDO`.)_

---

## Phase 3 — Match provisioning and assigned seats — **DONE (2026-08-15)**

**Deliverable:** the tournament opens real rooms for its ready slots, and only the right two people can sit down. 11 worker tests, including a whole 4-entrant tournament played over real sockets.

- [x] `TournamentDO.provision` opens a room for every ready slot without one. Idempotent and **pull rather than push** — called after creation and after every result, so a retry finishes a half-done run instead of opening a second room for the same match.
- [x] **`MatchDO` gains `tournament: { code, slotId }`**, snapshotted at creation like everything else in that object
- [x] **D41 — assigned seats by entrant token.** Three reversals of rules that are correct outside a tournament: not first-come, not the player id, and **not the claimed name either** — the tournament hands back the entrant's _registered_ identity and the seat is filled with that. The bracket and the leaderboard therefore cannot disagree about who played, and a new browser does not mint a second person mid-event.
- [x] Token in the URL fragment; refusals are named and distinguish `ENTRANT_TOKEN_REQUIRED`, `UNKNOWN_TOKEN` ("that link is not for this tournament") and `NOT_IN_MATCH` ("that link is for a different match")
- [x] **D41 — `relink` re-mints a token and can repoint the player id.** Tested: the old token stops working and the new one works, on a room that was already open.
- [x] **Tournament rooms excluded from the open lobby list** (D31) — never announced at all, rather than announced and filtered
- [x] `/api/match` **refuses** a client-supplied `tournament` binding, loudly rather than by stripping it
- [x] Rulesets come from the tournament's snapshotted config; `TournamentDO` addresses the match object directly, which is the only path that may attach a binding

### Deviations from the plan

- [x] **Authorisation is asked live, not snapshotted into the match.** The plan implied the match would hold what it needs. It holds the _ruleset_ — those must not change under the players — but not the token hashes: who may sit is exactly what an organizer needs to correct mid-event, and freezing it would make `relink` a lie for every room already open. The one place this design departs from §11's snapshot-everything instinct, and the split is rules-frozen / authorisation-live.
- [x] **The winner is reported by player id, not entrant id.** `MatchDO` has no business knowing this object's internal handles, and mapping in one place means a D41 relink is picked up automatically.

### Found while building — a gap the plan missed

- [x] **A tournament match can end in a draw, and a bracket cannot advance on that.** D21 makes 1.5–1.5 a legal terminal state and D36's Bo1 allows a tied single round outright, so any tournament using either mode can produce a match with no winner. The plan never mentioned it. Added `DRAWN` to `@banpick/bracket` as a first-class result: it resolves nobody, routes nobody, halts one branch, and waits for the organizer — the same answer D38 gives a dispute, and for the same reason. Replay, coin toss and walkover are all defensible and none of them is the app's call. **Phase 7 needs a "resolve a drawn slot" action alongside its dispute resolution.**
- [x] **A silent mis-mapping, caught by that test.** `results()` read rows back with `type === 'VOID' ? 'VOID' : 'DISPUTE'`, so a stored `DRAWN` came back as a dispute — the right branch halted for the wrong stated reason, and the only symptom was a word in the UI. Now an exhaustive switch that throws on anything unrecognised: a row this object wrote and cannot read is a bug, not a state.

### Known hole, deliberate and temporary

- [ ] **`relink` and `provision` are not gated.** Phase 7 mints the organizer token and puts every mutation behind it. They are reachable so Phase 3 could be tested end to end, and the router says so in a comment: **do not deploy before Phase 7** — anybody with a tournament code could currently re-mint an entrant's token.

**Exit criteria**

- [x] A worker integration test plays an entire 4-entrant single-elimination tournament end to end in workerd: rooms provisioned, matches played over real sockets, results returned through the bracket, the final opened automatically, a champion crowned
- [x] A third player cannot take a seat in a tournament match, and is told which kind of no it is
- [x] An entrant with a valid token seats successfully **from a browser with a different player id** — D41's whole purpose, and the case a player-id gate would have failed

**Do not build yet:** the graphic, and D38/D39's tightening of the result path. _(Held: reporting is still one-sided, exactly as D15 has it; Phase 4 is what makes it two-sided and freezes a consumed result.)_

---

## Phase 4 — Result integrity — **DONE (2026-08-15)**

**The phase that decides whether this is trustworthy.** 21 new tests — 14 in the engine under Node, 7 in workerd.

### D38 — both seats confirm

- [x] **A protocol change, and it lands on the ruleset.** `Ruleset.resultReporting: 'ONE_SIDED' | 'BOTH_SEATS'`, snapshotted into the creation event like every other rule — so a replay a year later applies what the match was actually played under rather than what the app does today.
- [x] `RoundState.reports: Record<Seat, RoundOutcome | null>`. Agreement sets `result` and scores; disagreement leaves it null. `isDisputed` is **derived**, never stored.
- [x] **Scoped to matches carrying a tournament binding**, derived in `MatchDO.handleCreate` from the binding itself rather than passed alongside it — two ways of saying the same thing could disagree, and the failure would be a tournament match quietly reporting one-sided.
- [x] **`legalActions` carries `confirming`**, so the client renders "They say X won — Agree / …" without deciding on its own that this is a confirmation. §11 non-negotiable 4 holds: there is still no branch anywhere in the client on "is this a tournament match".
- [x] Disagreement produces no winner and no score, and **either seat may change its claim** while the round is unresolved. Two people who misreported and then talked can fix it themselves; escalating every fat finger to an organizer would make the confirmation cost more than it saves.
- [x] Re-sending the _same_ claim is refused (`DUPLICATE_COMMIT`), so a double-clicked button is visibly a no-op rather than a second log entry saying the same thing.
- [x] **A dispute reaches the bracket while it is happening.** A disputed round never resolves, so waiting for `COMPLETE` would mean the organizer never heard about it — there is no afterwards. `MatchDO` reports it on settle and the slot shows `DISPUTED` while the other half of the bracket carries on.

### D39 — freeze on consumption

- [x] **`RESULTS_FROZEN` is an event, not a flag.** Freezing happens after creation so it cannot be snapshotted; putting it in the log keeps the engine pure, keeps replay exact, and — the part that matters to a player — makes `legalActions` stop _offering_ the undo instead of offering a button the server refuses.
- [x] `undoableRound` and D33's amendment both close on it
- [x] **The view carries the reason**, not a bare flag, and the client renders it above the round strip. A control that silently stops appearing is worse than one that explains itself.
- [x] **D34's admin edit refuses a tournament match** with `409 TOURNAMENT_MATCH`, naming the tournament. Editing the registry row would move the leaderboard and leave the bracket saying something else. `matches` gained a `tournament_id` column by `ALTER TABLE` — a `CREATE TABLE IF NOT EXISTS` with a new column is a no-op against a table that already exists, so the column would simply never have appeared.
- [x] Results reach `RegistryDO` tagged with the tournament id

### Found while building

- [x] **A Durable Object cycle that deadlocked.** The first shape had `TournamentDO` fetch the match's `/freeze` endpoint on consuming a result — an object calling back into the one mid-call to it. The visible symptom was a bracket that advanced correctly and then simply stopped opening rounds. **Consumption is now reported, not imposed:** the report's reply says `consumed: true` and `MatchDO` freezes itself. Same guarantee, no cycle, and one fewer public capability on the match — the `/freeze` route was deleted rather than left unused.
- [x] **The golden ruleset hash moved**, and legitimately: `resultReporting` is a real field and a match requiring both seats to agree is playing under different rules from one that does not. Re-pinned with a note, exactly as D28 did when it added `repeatBans` — the test already carries the precedent for when a re-pin is a decision rather than a chore.

**Test gates**

- [x] Reported and undone **before confirmation** advances nobody; one report leaves the round unresolved and the match `IN_PROGRESS`
- [x] Conflicting reports produce `DISPUTED`, and the other half of the bracket keeps advancing
- [x] A consumed result cannot be undone or amended by a player, and the refusal is **explained** rather than silent
- [x] **Casual play is untouched** — one-sided report, no confirmation ever offered, D15's undo window exactly as written. Asserted in the same files as the tournament behaviour, so a change that leaks fails immediately.

**Exit criteria**

- [x] Every path that can change a completed result either updates the bracket or is refused, with a test for each

---

## Phase 5 — Live bracket transport — **DONE (2026-08-15)**

**Deliverable:** the bracket updates on screen without anybody refreshing. 9 worker tests.

- [x] WebSocket endpoint on `TournamentDO`, using **hibernation** — a tournament runs for a week (D42), and an object held awake by a dozen idle spectators for that long is exactly the cost §11's headroom table exists to avoid
- [x] **All sends go through `outbound.ts`.** The choke point was extended, not duplicated; `check-outbound.mjs` still reports one file.
- [x] Broadcast on every change, hung off `touch()` — the one function every write already calls. Remembering to call `broadcast` at each site would fail as a bracket that is right on refresh and stale on screen, which is the hardest kind of wrong to notice.
- [x] **Spectators are first-class.** No token, no seat, no tags. A bracket is public for the same reason D31's lobby list and D34's history are, and most people watching one are not playing in it.
- [x] Full state on connect and on every change, no deltas — so a reconnect is not a special case, the same choice D17 makes for `VIEW`
- [x] The socket is **read-only and says so**, rather than dropping what it is sent in silence
- [x] One `currentView()` builder feeds both the HTTP read and the socket frame, so the two cannot drift

### The redaction gate

- [x] **Asserted on raw frames**, in the style of `hidden-select-leak.test.ts`: every character id either side is holding mid-match, plus the vocabulary a match frame is made of (`bannedInRound`, `metaBanPlaced`, `legalActions`), checked absent from the wire.
- [x] Entrant tokens never appear either — they would be visible to every spectator at once
- [x] **The guarantee is structural, not filtered**, and the test says so: a `TournamentView` has no field that could hold match state, so there is nothing to redact. The test exists to keep that true the day somebody adds "current draft" to the bracket as a nice touch.

**Exit criteria**

- [x] A watcher who did nothing sees a slot resolve, and two watchers both receive a change
- [x] A redaction test on the tournament socket's frames

**Note for Phase 6:** one completed match produces **two** frames — the bracket advances, then the next round's room opens a moment later. Both are real moments; a graphic that assumes one update per match will flicker or miss the room.

---

## Phase 6 — The bracket graphic — **DONE (2026-08-15)**

**Deliverable:** the bracket on screen, live. 28 component tests.

- [x] `components/Bracket.tsx` — inline SVG, **layout is a pure function** of `(side, round, match)` and the entrant count. No measurement pass, no ref, no library. A layout that measures cannot be tested without a renderer that lays out, and the sizing case here is the one nobody would check by hand.
- [x] Winners band on top, losers beneath, grand final to the right of both. A round's matches spread evenly over their band, which reproduces the doubling-gap tree **without computing midpoints** — a round with half as many matches gets twice the spacing by construction. Asserted: round two sits at the midpoint of the two boxes feeding it.
- [x] All eight slot states visually distinct, one test each
- [x] **D40 — the reset is labelled "reset"**, not drawn as a second grand final, and sits below it
- [x] **The mode on every slot** — a Bo1 losers bracket beside a Bo3 winners bracket is the feature, and a drawing that does not say which is which hides it
- [x] The viewer's own match outlined in gold; nothing highlighted for a spectator
- [x] An unfilled side reads "winner of W1M2" rather than blank — the question a reader is actually asking
- [x] **Scrolls inside its own container.** 32 entrants is ~1400 units wide; letting that reach the document would put a horizontal scrollbar on the _page_ and make every other screen feel broken on a phone.
- [x] `screens/Tournament.tsx` and the `/t/:code` route, live over Phase 5's socket
- [x] "Your match is ready" — a plain link carrying the entrant token on from this page's own fragment, because seating is the consent (§12.3) and the tournament never sits anybody down on their behalf

### The accessible bracket is not a fallback

- [x] An `<ol>` of rounds, always in the DOM, with the SVG `aria-hidden` so the two are never announced together. It is what a screen reader reads and what a **printer** prints — the form an organiser is most likely to want on paper.
- [x] Tested against the drawing: same slots, same modes, same winners, and "to be decided" where a side is unknown

### Two deviations

- [x] **"Both themes" does not apply.** The app is one committed dark theme (`styles.css` says so at the top), not a light/dark pair. Everything is drawn from its tokens; there is no second palette to check.
- [x] **No reconnect ladder on the bracket socket.** `transport.ts` has one because a player who cannot act is stuck; a watcher who drops sees a stale bracket and can refresh. Building the backoff machinery a second time for that would be weight the case does not justify — so the page carries a live/reconnect badge instead, which is the honest signal.

### Found while building

- [x] **A pre-existing structural test caught a real regression in my own CSS.** `sizing.test.tsx` requires every `--modifier` to have a base rule, because twice before a modifier outlived the rule it modified and the variants ended up doing all the drawing. My first pass had exactly that shape: `.bslot--ready .bslot__box` and friends with no `.bslot`. Rewritten so the **base draws the box** via custom properties and each state sets one variable — losing a state now costs a colour, and losing the base is impossible because there would be no variables to set.

**Exit criteria**

- [x] Renders 4, 8, 16 and 32 entrants, single and double elimination, without the page scrolling sideways
- [x] A component test per slot state, and one asserting the accessible list matches the drawn bracket

---

## Phase 7 — Organizer console — **DONE (2026-08-15)**

**The phase that makes this deployable.** 29 worker tests, plus the console screen.

- [x] **A per-tournament organizer token, minted at creation and returned once.** The recommendation held and the reasoning is in the code: `ADMIN_KEY` is deployment-wide and gates rewriting _everyone's_ recorded results. Running Thursday's event should not require it, and handing it out so somebody can is how it leaks. A test asserts the admin key is **not** accepted here.
- [x] **Fails closed** — a tournament with no organizer token has no organizer, not an open one. Same rule as `ADMIN_KEY` (D34).
- [x] **The gate is an allowlist inside the object, not a check per handler.** A per-handler check is one `if` away from being missed on the day somebody adds the eighth action, and the failure is silent: the endpoint simply works for everybody. The test walks **every** mutating route rather than a sample.
- [x] Re-seed before the first match; refused with `ALREADY_STARTED` afterwards, because that is not a re-seed, it is rebuilding the bracket around games people have already played
- [x] **Substitution only**, never add or remove. Removing leaves a slot with one side and nothing to fill it; adding is a different bracket. Substitution keeps the shape and changes who is standing in it — and it is what actually happens when somebody has to leave. The departing entrant's token stops working at the same moment.
- [x] **`resolve` covers three situations through one action** — D38's dispute, a `DRAWN` slot, and a no-show walkover. They are the same act (_the organizer has decided this_) and the reason is what distinguishes them, so **the reason is required** and recorded. A forced advancement with no reason is indistinguishable a week later from one somebody made up.
- [x] `results` gained `decided_by` and `reason` by `ALTER TABLE`. An organizer overruling two players is a different event from those two players agreeing, and a log that cannot tell them apart cannot answer the only question anybody asks afterwards.
- [x] **D39 — `cascade` shows what a correction costs before it is applied**, split into downstream matches that were _played_ and ones merely _waiting_. Voiding the played ones is a checkbox the organizer ticks, not something the app decides: whether a game that really happened still counts is a judgement about the evening.
- [x] `voidSlot` drops the room so a re-run gets a fresh one — replaying into the room that produced the voided result would land in the same match log
- [x] D41's relink, now gated

### The hole this closes

- [x] **`relink` and `provision` were reachable by anybody with a tournament code**, flagged in this plan since Phase 3 and carried in a comment in the router saying _do not ship before Phase 7_. Both are now behind the token, the comment is gone, and the gate test covers all seven mutations.

**Exit criteria**

- [x] Every destructive action is two-step and names what it will affect — matching `/admin`'s standard, and the correction goes further by naming the _downstream_ matches too
- [x] The organizer token gates every mutation, and a tournament without one has no organizer rather than an open one

---

## Phase 8 — History and records — **DONE (2026-08-16)**

**The phase that decides what is left in a year.** Everything before this lives in a Durable Object that deletes itself seven days after anybody last touches it (D42) — which is right, and which means the whole tournament is written in disappearing ink until this phase.

- [x] **Tournament results reach `/history` and the leaderboard, distinguishable from casual games.** They always reached both: a bracket match is an ordinary match that files an ordinary row. The distinguishing was the missing half — `tournament_id` had been written since Phase 4 and never once read back, which is indistinguishable from a column nobody needed. It now comes back on `MatchRecord` and the history shows it as a link to the bracket.
- [x] **`RegistryDO` gains a tournament index.** A `tournaments` table, upserted on every write the tournament makes (hung off `touch`, for the same reason the broadcast is), and `/api/tournaments` — public, like the history it sits beside.
- [x] **A finished tournament has a permanent page: final bracket, champion, every match.** The champion and the entrants are in the index; every match is in the history, carrying the code. The final **bracket** needed a decision — see below.
- [x] **Head-to-head includes tournament games, and is not split.** They are games these two people played, and a record that excluded them would be wrong in the direction nobody expects. Not split into two records either: most pairs would get two half-empty ones, and the in-match line is already labelled `All-time` — the one place a second number would land is a match screen where D29's own bug report was that a _single_ unlabelled number reads as the current score. The per-match flag lives on the history rows, which is where somebody asking "was that a bracket game?" is actually looking.

### The bracket is the one thing that cannot be derived

The first draft of the `tournaments` table stored a summary and said so in a comment: the slot-by-slot structure is derivable from the match rows, so a second copy here would be a second thing to disagree.

That was wrong, and it is recorded rather than quietly fixed because the reasoning was appealing. Matches carry no slot ids and no edges. And a slot the organizer resolved — a no-show, a void, a walkover — produced **no match row at all**, so a bracket rebuilt from matches would be missing exactly the results somebody wants explained. What the summary bought was a history page that told the truth and linked to a tournament page that 404'd.

So a **finished** tournament files its final view, and `/api/tournament/<code>` falls through to it when the object is gone:

- Filed only when complete, and re-filed as `null` when a D39 correction unfinishes one — the archive can never serve a bracket that has since moved.
- The fallback is for a **swept** object, not a slow one. A running tournament answers for itself; an archived copy of a live bracket would be the one thing on the page that cannot update, and it would look right.
- Marked `archived: true`, and the page says `Archived` rather than `Reconnect` — and opens no socket, because there is nothing left to watch.

### Found while building

- **`no such table: tournament` after the sweep.** The instance outlives `deleteAll()`, so the next request found no tables and failed as a 500 — which is not what a swept tournament is. `migrate()` is extracted and re-run after the sweep, and `meta()` tolerates the missing table narrowly (that message only) rather than swallowing every read error.
- **A race in the Phase 3 exit test, exposed by the suite growing.** It read the bracket immediately after a match ended and assumed the next round was open. Two asynchronies sit in between and both are deliberate: `MatchDO` reports on a `waitUntil` so no player waits for the bracket, and `report` records the result _before_ it opens what that unlocked — so a read can legitimately land between them. The test polls now, which is it agreeing with the design rather than papering over a flake.
- **The tournament page opened its socket beside the first read rather than after it**, so a frame arriving mid-flight could be overwritten by the staler answer landing second. Fixed while adding the archived path.

**Exit criteria**

- [x] A tournament's result outlives the object that produced it, verified by a test that sweeps the object exactly as the alarm does and then reads the page
- [x] An unfinished tournament is not archived — a bracket abandoned half-played has no final anything, and inventing a page for it would be showing a result that does not exist

---

## Phase 9 — Creating one — **DONE (2026-08-16)**, and not in the original plan

**The gap the plan missed.** Eight phases shipped a tournament layer that nothing in the app could start: `POST /api/tournament` worked and no screen called it, so the whole feature was reachable only with `curl`. Every phase had exit criteria and none of them was _a person can create one_ — worth recording, because the plan read as complete while the feature was undeliverable.

- [x] `screens/NewTournament.tsx` at `/organizer`, **linked from the front door**. Unlike `/admin` and the console, this one has to be findable: those two are destructive screens kept out of the way, and starting a tournament is an ordinary thing to want.
- [x] Entrants typed one per line. Format, seeding, D40's reset, the default mode, and a per-position override for the losers bracket and the final — the "Bo1 losers bracket under a Bo3 winners bracket" the request asked for, as two dropdowns.
- [x] Only the positions that differ are sent. The fallback chain stays the server's (`chainFor`) rather than being reimplemented in the client, where it would be a second copy of the one rule in this layer that is not obvious.
- [x] **The handover screen.** The organizer key and one link per entrant, all on screen at once, repeated as a block to paste. They are minted once and stored only as hashes (D41) — anything this screen does not show is gone, and it says so.

### Identity, which is the part that is not a form

An entrant needs a player id and a player id belongs to a **browser** (D35) — which the organizer is not sitting at. So a typed name is matched, case-insensitively, against the public matchup table, and an unrecognised one gets a minted id:

- A regular's bracket games land on the record they already have, which is the common case for the group §1 describes.
- A stranger's do not, and the screen **says so on the chip before the tournament is created** rather than leaving it to be discovered on the leaderboard afterwards. D41's relink and D35's merge are both still there to fix it.
- The directory comes from `/api/matchups`, which is public. Reading `/api/admin/players` instead would have put this whole screen behind the admin key to answer a question the history already answers in the open.

### Found while building — the layer was unplayable from a browser

Reported from real use: _"even when trying to join rooms even from the direct link, I get 'this seat is reserved — open the match from your entrant link'."_

**The client never sent the entrant token.** The tournament page links an entrant to `/j/CODE#token` — fragment, so it never reaches a request log — and `claimSeat` posted the player id and display name and nothing else. So every entrant was refused for not having done the one thing they had just done, and D41's seating worked only for `curl`.

The reason nine phases of tests missed it is worth keeping: **the worker's test client sends the token itself.** `TestClient.claimSeatWithToken` existed from Phase 3, so the suite played whole tournaments over real sockets through a path the real client did not have. The repo's own rule is that the test client must be able to do only what the real one can (§11.4, D18) — this was that rule failing in the other direction, and it is the second time a test client has been more capable than the app.

Three fixes, and each closes a different part of it:

- [x] `claimSeat` carries the entrant token when the fragment has one, and the lobby strips it from the address bar once seated — the same treatment D17 gives a resume token, and for the same reason: it opens that seat for the length of the event.
- [x] **`LobbyPreview` gained `tournament`**, so the lobby can say a seat is reserved _before_ offering it. Without it the only way to find out was to type a name, press the button and be refused — correct, and arriving at the worst possible moment. A spectator who followed a room code now gets an explanation and a link to the bracket.
- [x] An entrant arriving with their link is **not asked for a name**. The tournament seats them under their registered identity, so the field was collecting something the server discards, and requiring it blocked the seat on it.

### And the recovery that did not exist

- [x] **The organizer console can re-issue an entrant link.** `relink` was built and gated in Phase 7 and nothing ever called it, which made a lost link the end of that entrant's tournament — there is no lookup, because only the hash is stored. Two-step like every other action there, and it says plainly that the old link stops working immediately, everywhere, including a match they are already sitting in.

**Exit criteria**

- [x] A tournament can be created, handed out, played and finished without ever leaving the browser
- [x] The config the screen sends is asserted against the server in a worker test, so a form that grows a field the server has never seen fails in CI rather than on the night
- [x] An entrant seats from the **real client**, asserted in `apps/web/test/entrant-seating.test.tsx` — the gap above was invisible to a worker suite that plays whole tournaments

| Risk                                                             | Phase | Looks like                                                                  | Mitigation                                                                                                      |
| ---------------------------------------------------------------- | ----- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Double-elimination routing is wrong in a way nobody notices**  | 1     | A rematch that should not happen; someone out on one loss                   | Exhaustive playout tests at N=4 and N=8; known-good brackets from published sources                             |
| **A consumed result changes and the bracket silently disagrees** | 4     | The history page and the bracket name different winners                     | Phase 4 exists for this. The fold-vs-incremental equality test is the one that catches it                       |
| **The organizer token becomes `ADMIN_KEY` "just for now"**       | 7     | One key gates both a tournament and every recorded result in the deployment | Decide in Phase 7 before the console exists, not after                                                          |
| **Scope creeps into round robin, Swiss, group stages**           | any   | "While we're in here"                                                       | Named in _Not building_. The pure package makes them cheap **later**; adding them now triples the test surface  |
| **A tournament outlives its Durable Objects**                    | 2     | A bracket referring to room codes whose `MatchDO` storage is gone           | The bracket stores results, never links to live match state. Test with a swept match                            |
| **The single-object scale note comes true**                      | 0     | 32 entrants, every write serialised through one DO                          | D42 caps it at 32, states it, and puts the warning in the file the way `RegistryDO` does                        |
| **§17 quietly contradicts the codebase**                         | 0     | A doc saying this will never be built, next to the thing                    | Phase 0 strikes it. Do not leave it for a reader to trip over                                                   |
| **D38's confirmation leaks into casual play**                    | 4     | Friends asked to confirm each other's results in a kitchen-table game       | Scoped to matches carrying a `tournament` binding, with a casual-path regression test in the same file          |
| **D39's freeze is discovered rather than explained**             | 4     | A player's undo button is simply gone and nobody knows why                  | The frozen state is shown and reasoned in the UI, not merely enforced in the reducer                            |
| **D40's reset makes the bracket non-terminating**                | 1     | A reset that can itself reset                                               | `GF2` is terminal by construction, and the G14-style termination test covers `grandFinalReset: true` explicitly |
| **D41's token is treated as an account**                         | 3     | Feature requests for password reset, email, login                           | It is a bearer credential with D17's exact trade: lose the browser, lose it, and ask the organizer to re-mint   |

---

## Not building (v1 scope guard)

- **Round robin, Swiss, group stages.** The package is shaped so they can be added; adding them now triples the test surface for a format nobody has asked for.
- **Third-place playoffs.**
- **Best-of-N across multiple rooms per slot.** A slot is one match. A "best of 3 matches" slot is a different feature from a Bo3 mode, and conflating them will confuse both.
- **Scheduling, check-in windows, timers, forfeits on the clock.** The engine has no clock (§5) and this layer should not be the first thing to introduce one.
- **Accounts.** D19's identity model stands: a name you type and an id your browser generates. This plan works within it rather than reopening it.
- **Chat, streams, overlays.**

---

## Suggested order of work

**Followed as written, 0 through 8, and it held.** Phase 1's exhaustive sweep caught a routing bug that would have been found much later and much more expensively — see that phase — which is the argument for the order rather than a happy accident.

Phases 0 → 1 → 2 → 3 → 4 are sequential; each genuinely blocks the next. **Phase 6 (the graphic) can start against a mocked bracket as soon as Phase 1 fixes the types** — the same trick the delivery plan used to let the client start against a mocked transport once the protocol was frozen. Phases 7 and 8 are independent of each other and can follow in either order.

The temptation will be to build Phase 6 first, because it is the visible part. Resist it exactly as far as the types: a bracket graphic drawn against a shape that has not been proven by Phase 1's exhaustive tests will be redrawn.
