# Spec Gap Register

**Source:** `banpick-design-spec.md` (Accepted, 2026-07-28)
**Purpose:** Every item below is a place where two engineers could read the spec and build different software. Each needs a decision row appended to §2 of the spec, or an explicit deferral naming the phase it may safely block.

The spec is unusually good — event-sourced, pure engine, set-algebra pools, per-slice visibility. That quality is exactly why these gaps matter: the architecture is sound enough that the remaining risk is entirely in underspecified rules, not in structure.

**Legend:** **Blocking** = an engineer cannot write the code without guessing. **Sharp** = code can be written, but the wrong choice is expensive to reverse.

## Status board

| #   | Title                                                           | Status                                                                                                |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| G1  | Round 1 privilege doubly determined                             | **RESOLVED → D10**                                                                                    |
| G2  | Round 2 `CHOOSE` degenerate                                     | **RESOLVED → D11**                                                                                    |
| G3  | Self-duplicate drafts                                           | **RESOLVED → D12**                                                                                    |
| G4  | Round 2 `skip: [SELECT]` emits no event                         | **RESOLVED → D13**                                                                                    |
| G5  | Client engine import vs trust model                             | **RESOLVED → D18** (`@banpick/types` to the client, `@banpick/engine` to the DO only, enforced in CI) |
| G6  | No disconnect / abandon / timeout policy                        | **RESOLVED → D17** (seat token, resume link, full resync, 7-day idle expiry, no forfeit)              |
| G7  | `ruleset.hash` canonical serialization                          | **RESOLVED → D20** (hash cut from URL)                                                                |
| G8  | "Tournament app" has no tournament layer                        | ~~RESOLVED → D19~~ **REOPENED → D37** (2026-08-15). See [`TOURNAMENT-PLAN.md`](TOURNAMENT-PLAN.md)    |
| G9  | O1 understated; sample size too small                           | **RESOLVED → D22 / D25** (default 4; `draftCount` is a host-selectable parameter, A/B tested via §15) |
| G10 | `VOID_AND_REPLAY` / `ROLL_OFF` unspecified                      | **RESOLVED → D21** (cut, deferred not permanent)                                                      |
| G11 | The roster does not exist                                       | **RESOLVED → D14** (`roster/roster.json`, retire never delete)                                        |
| G12 | No actor or dispute policy for `REPORT_RESULT`                  | **RESOLVED → D15** (either seat reports, no confirm, `UNDO_LAST_RESULT` until the next roll)          |
| G13 | No engine versioning; replay is silently unsound across changes | **RESOLVED → D16** (`engineVersion` in the creation event, replay refuses on major mismatch)          |
| G14 | No validator that a (scoring × resolution) pair terminates      | **RESOLVED → §13** (sixth load-time validator; implemented in Phase 2)                                |

**Phase 0 is closed.** Every item G1–G14 carries a resolution, and D10–D26 hold the decisions. G14's decision is made and its _implementation_ lands with the rest of the validators in Phase 2, which is a build task rather than an open question.

The pattern in G11–G13 is still worth naming, because it is the failure mode to watch for in later phases: the spec was rigorous about everything it _chose to model_ and silent about the things it _assumed_. A roster, a result, and a version were all assumed to exist. None of them did.

---

## G1 — Round 1 privilege is doubly determined — RESOLVED → D10

§9.1 round template runs `ROLL` → `CHOOSE(rollWinner, [DRAFT_PRIVILEGE, TURN_ORDER])`. The round-index-1 override then sets `privilegeHolder: "!round0.privilegeHolder"` outright.

Both cannot be true. Either the roll decides privilege, or the inversion does.

**Options:**

- **(a)** Round 1 skips `ROLL` and `CHOOSE` entirely; privilege inverts, turn order goes to the complement holder. Deterministic, no dead roll on screen.
- **(b)** Round 1 rolls, but `CHOOSE` is narrowed to `[TURN_ORDER]` only, because privilege is already assigned. The roll then decides turn order alone.
- **(c)** The override is a _tiebreak default_ that only applies when the roll ties — but §9.1 already sets `onTie: REROLL`, so this reading is dead.

**Recommendation: (a).** It matches the stated intent of O1 ("privilege alternates") and removes a roll whose outcome the UI would have to explain as meaningless. Note that (a) means `overrides` must be able to remove modules, not just re-parameterize them — a loader capability worth confirming in Phase 2.

> **Resolved 2026-07-28 → D10.** Option (a). The round-0 roll decides; round 1 inverts. The inversion applies to **both** privileges, not draft privilege alone — otherwise the round-0 winner would keep turn order across two consecutive rounds and the alternation would not actually be symmetric.
>
> Round 2 was not covered by the answer and is derived: it rolls fresh for turn order only (D11), because with no draft privilege there is nothing left to alternate and a third inversion would hand the decider to whoever lost the round-0 roll. **Flagged for a nod** — this is the one piece of D10 that was inferred rather than stated.
>
> **Consequence, logged as O5.** Round 1's privilege is now knowable at round 0, and per G9 it is the stronger one. So the round-0 `CHOOSE` stops being "which privilege do I want" and becomes "do I want the weaker one now or the stronger one next round." That is a better decision than the mode had before, and it inverts the expected sign of the §15 privilege-choice metric. Do not read a high `TURN_ORDER` rate as players undervaluing the draft.

---

## G2 — Round 2 `CHOOSE` is degenerate — RESOLVED → D11

§10 states plainly: "Round 3: the turn-order holder (no draft privilege exists)." But the round-index-2 override only declares `skip: [BAN, SELECT]`. `CHOOSE` survives, still offering `DRAFT_PRIVILEGE` as an option that grants nothing.

**Decision needed:** round 2's override must narrow `CHOOSE.options` to `[TURN_ORDER]`. Otherwise a player can pick the empty privilege and hand the opponent turn order for free, which is a strictly dominated action the engine happily permits. `legalActions()` should never surface a dominated-by-construction action; that is a design smell, not just a UI problem.

> **Resolved 2026-07-28 → D11.** Stronger than the original recommendation: `CHOOSE` is **removed**, not narrowed. A `CHOOSE` with one legal option is still a round trip, still a client render, still an event, and still a state the UI has to explain. The roll assigns `TURN_ORDER` directly via `rollAssigns: TURN_ORDER`.
>
> Side effect worth noting: §10's `advantageHolder` for round 2 was previously undefined in practice — it named the turn-order holder, but no round-2 module assigned turn order. D11 closes that hole as a byproduct. The §10 table now states the assigning mechanism per round explicitly.

---

## G3 — Are self-duplicate drafts legal? — RESOLVED → D12

D1 says "Mirrors allowed." §9.1 says `mirrors: ALLOWED`. Neither states whether _one seat_ may fill two or three of its own slots with the same `characterId`.

This is not cosmetic. It changes three things:

1. **Meta ban blast radius.** If self-duplicates are legal, one meta ban can void all three of a seat's slots at once (`repickTrigger` matches on `characterId`, and picks are a slot array). That is a swing the spec never discusses.
2. **The §13 roster viability rule.** `|roster| - |tournamentBans| >= 4` is only correct under one reading. If self-duplicates are legal, the true floor is 2 (one to draft ×3, one spare after a meta ban). If they are illegal, the floor is 4 and the current rule is right but for the wrong reason — and it is still wrong at the edge, because after a meta ban a seat needs 3 _distinct_ legal characters, requiring `|roster| - |tournamentBans| - 1 >= 3`, i.e. `>= 4`. Coincidentally correct. Do not leave a validator standing on a coincidence.
3. **Whether `bring3-ban1` is a real decision.** Under self-duplicates, "bring the same character three times and eat the ban" is a live strategy the mode was probably not designed for.

**Recommendation:** forbid self-duplicates (`mirrors: ALLOWED` means _across_ seats only), and rename the flag `crossSeatMirrors` so the ambiguity cannot recur. Add `selfDuplicates: FORBIDDEN` as an explicit pool constraint so a future mode can flip it.

> **Resolved 2026-07-28 → D12.** Forbidden. Implemented as recommended: `mirrors` is split into `crossSeatMirrors: ALLOWED` and `selfDuplicates: FORBIDDEN`, both carried on `Ruleset.constraints` so they are snapshotted at match creation (§11 non-negotiable 2) rather than read live.
>
> The constraint lands as an extra set difference in `legalDraftPool`, which is now **slot-indexed**: `legalDraftPool(seat, slotIdx)` excludes characters held in the seat's _other_ slots. The indexing is not cosmetic — without it, a `CONDITIONAL_RECOMMIT` on slot 1 would be forbidden from re-selecting slot 1's own character, which is not the rule D12 states.
>
> §13's roster floor is now derived rather than asserted: a repicking seat needs 3 distinct characters and has 1 denied to it, so `|roster| - |tournamentBans| >= 4`. Same number as before, but for a reason — and the derivation is checked into the validator comment, because if D12 ever flips the correct bound drops to 2.

---

## G4 — Round 2 `skip: [SELECT]` leaves no commit event — RESOLVED → D13

Skipping `SELECT` in the final round is correct game design — each seat has exactly one unconsumed slot, so there is nothing to choose. But an event-sourced engine with no emitted event has no record that the slot was played, no `consumed` transition, and nothing to replay.

**Decision needed:** the final round must emit a system-authored `SELECT` event (actor: `SYSTEM`, reason: `FORCED`) rather than skipping. The rule is: `skip` may remove a _decision_, never a _state transition_. Worth writing into the module contract in Phase 2 so the loader can reject any mode that skips a slice-writing module.

> **Resolved 2026-07-28 → D13.** `skip` is retired as a keyword, because it was doing two jobs under one name. It splits into:
>
> - **`remove: [...]`** — deletes a decision module. Nothing was going to be recorded, so nothing is lost. Round 1 uses it for `ROLL`/`CHOOSE`; round 2 uses it for `CHOOSE`/`BAN`/`SELECT`.
> - **`forcedSelect: { actor: SYSTEM, reason: FORCED, seats: BOTH, target: theSingleUnconsumedSlot }`** — replaces a state transition whose decision became trivial. The event is still appended, still authored, still replayable.
>
> A fifth load-time validator enforces the distinction (§13, _transition preservation_): `remove` may not name a slice-writing module unless the override supplies a forced substitute. This is the validator that would have caught the original bug at load time instead of at replay time, which is the whole argument for having a loader.

---

## G5 — Client engine import contradicts client trust model — RESOLVED → D18

§5 ships the engine as "a standalone package imported by both the Durable Object and the client." §11 non-negotiable 3 says "the client renders `legalActions()` and nothing else. It never computes legality independently."

If the client imports the engine, it _can_ compute legality, and the first time someone wants a snappier UI they will — then the two implementations drift and the redaction guarantee in §7 becomes a suggestion.

**Recommendation:** split the package. `@banpick/types` (interfaces, `PlayerView`, serialization) is imported by the client. `@banpick/engine` (`reduce`, `legalActions`, `project`) is imported only by the Durable Object. Enforce with a dependency-cruiser rule in CI. Cheap now, unbuyable later.

---

## G6 — No disconnect, abandon, or timeout policy — RESOLVED → D17

The spec covers reconnect nowhere except implicitly in §14 step 3. A hidden simultaneous commit is exactly where a disconnect hurts most: seat A has committed, seat B is offline, and A's commit is sealed but A now knows they are waiting.

**Decisions needed:**

| Question                                            | Candidate default                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Per-action clock?                                   | None for v1. Friendly-opponent trust model (§1).                                   |
| Match idle expiry                                   | 24h, then the DO evicts and the match is archived to log-only                      |
| Reconnect                                           | Full `project()` resync on WS open; no partial deltas                              |
| Can a committed-but-unrevealed action be withdrawn? | No. Commit is final; this is what makes the seal meaningful                        |
| Abandon                                             | Host may abandon pre-`SEAT_FILLED` (§12). Post-lock, no abandon — record `FORFEIT` |

The interesting one is withdrawal. Say no and the seal is a real cryptographic-strength guarantee at the protocol level. Say yes and you have re-invented take-backsies with extra steps.

---

## G7 — `ruleset.hash` has no canonical serialization — RESOLVED → D20

§12 puts the hash in the join URL and promises "a stale link against a changed ruleset fails loudly." That promise is only as good as the serialization: key ordering, array ordering of `tournamentBanned`, whitespace, and whether `label` participates.

**Decision needed:** hash over a canonical form — sorted keys, sorted `tournamentBanned`, `label` excluded (cosmetic changes must not invalidate live links), `rosterVersion` and `modeId` included. Specify the algorithm (SHA-256, first 12 hex chars for URL length) and write a golden-hash test in Phase 2.

---

## G8 — "Tournament app" has no tournament layer — ~~RESOLVED → D19~~ **REOPENED → D37**

The repository is named `dice-t-ban-and-pick` and the brief was a _tournament_ app. The spec describes a two-player match tool. Tournament bans exist (§4, D5, "set by organizer, event lifetime") but there is no event entity, no organizer role, no bracket, no standings, and no match provisioning.

This is not a criticism of the spec's scope — a sharp v1 is correct. It is a warning about two decisions that Phases 1–3 will make silently and that Phase 7 cannot cheaply undo:

1. **Match identity.** If the DO's only key is a room code, there is no place to hang an `eventId`. Add a nullable `eventId` to the creation event now. One field.
2. **Ruleset ownership.** §12 has the _host_ choosing the mode and ban list. In a tournament, the _organizer_ does, and the host may not override. Model `Ruleset` as resolvable from an event, not only from host input, even if v1 only ever uses host input.

**Recommendation:** keep the tournament layer out of v1, but land those two affordances in Phase 1. If the answer is "tournament is v1," this register needs a different conversation and the phase plan below shifts substantially.

> **2026-08-15 — the answer became "tournament is v1", and this warning was right.**
>
> D19 declined both affordances; D37 reinstates the layer, and [`TOURNAMENT-PLAN.md`](TOURNAMENT-PLAN.md)
> Phases 2–3 are largely those two paragraphs, built four phases later against a shipped protocol
> instead of a blank one. The cost is real but modest — a snapshotted `tournament` binding rather
> than a nullable `eventId`, and a create path that bypasses host input.
>
> It is worth being precise about what this vindicates and what it does not. **The warning was
> correct; the recommendation to act on it was still wrong.** Carrying two unused fields through
> Phases 1–6 would have cost more attention than retrofitting them once has — the register said
> "one field", and one field with no consumer is a field that quietly rots. What actually cost
> something was D19's _permanence_, which turned an open question into a closed one and let §17,
> the delivery plan, and D15's rationale all harden around an assumption nobody re-examined.
>
> The lesson is not "keep more doors open". It is that a register may record an answer without
> recording that the answer can never change.

---

## G9 — O1 is understated — RESOLVED → D22 / D25

O1 says round 2's privilege is "strictly stronger than round 1" and proposes measuring before fixing. Agreed on the method. But the magnitude deserves a written prior so the measurement has something to falsify.

Round-by-round, an unconsumed-slot count for the ban target: round 0 leaves the opponent 2 options after a ban, round 1 leaves 1, round 2 leaves 0 choices at all. The privilege is not merely stronger in round 1 — it is _total_, because banning the opponent's only unbanned option forces their play with perfect information. The player who wins round 0's roll and takes `DRAFT_PRIVILEGE` gets a normal advantage; the player who holds it in round 1 gets to dictate.

**Recommendation:** write the falsifiable prior into §15 — "round-1 privilege holder wins ≥65% of round 1s" — and treat the drafting-4 fix in O1 as pre-approved if the data clears it. Twenty matches (§15) will not resolve a 65/35 split with any confidence; that needs roughly 80–100 rounds. Adjust the stated sample size or accept a directional read.

---

## G10 — `VOID_AND_REPLAY` and `ROLL_OFF` are listed but unspecified — RESOLVED → D21

§10 offers both as available scorings. `VOID_AND_REPLAY` needs a hard cap ("falls back to `ROLL_OFF`") whose value is unstated, and voiding must un-consume characters, which is the only place in the design where `consumed` moves backward. That is a real reducer branch, not a config line.

**Decision needed:** either specify the cap (suggest 2 replays) and accept the reverse transition, or cut both scorings from v1 and leave `COMPENSATION` and `HALF_POINT` as the only shipped options. Cutting is the practical answer; they can return once tie frequency data exists.

---

## G11 — The roster does not exist — RESOLVED → D14

`roster` is the base set of every pool expression in §6. `rosterVersion` is snapshotted into the creation event (§11). `|roster|` is the input to the §13 viability validator. And the spec never says what a character _is_, where the roster comes from, or what a version bump means.

You cannot write a single Phase 1 test fixture without answering this.

**Decisions needed:**

| Question                    | Recommendation                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| What is a `Character`?      | `{ id, name }` and nothing else for v1. Art, stats, and flavour are Phase 4 concerns and do not belong in the engine's input |
| Where does the roster live? | A versioned JSON asset in the repo, loaded and validated alongside the mode. Not a database, not hardcoded                   |
| Is it part of `Ruleset`?    | Referenced by `rosterVersion`, resolved at match creation, snapshotted. Same discipline as the ban list                      |
| What bumps `rosterVersion`? | Any change to the set of IDs. Renames do not — the ID is the identity                                                        |
| How large?                  | See below. This is not a data question                                                                                       |

**The size question is a balance question.** At the §13 floor of `N = 4`, `bring3-ban1` is nearly deterministic: each seat drafts 3 of 4, so the opponent's holdings are almost fully known before any information is revealed, and the meta ban has nothing to discover. The mode's entire premise — "did they bring this?" — requires enough roster that drafting is genuinely private information. That probably starts somewhere north of 8 and is worth a deliberate choice rather than an accident.

Phase 1 can proceed on a fixture roster of 10–12 invented IDs. The real roster can lag until Phase 4. But the _shape_ must be decided now, because it is the type signature of everything downstream.

---

## G12 — Nobody is specified to report the result — RESOLVED → D15

`REPORT_RESULT` appears in §8 with a one-line description and in §9.1 with `allowTie: true`. It has no actor, no confirmation policy, and no dispute path.

This matters more than its one line suggests. The dice game is played **off-app** — this tool brackets the game, it does not run it. So `REPORT_RESULT` is the single point where a human types an unverifiable claim into an otherwise fully authoritative system. Every other module has the Durable Object as the source of truth. This one has a person.

**Options:**

- **(a) Winner reports, opponent confirms.** Two events, round blocks on the confirm. Safest, slowest, adds a wait state to every round.
- **(b) Either seat reports, no confirm.** Fastest. Justified by §1's friendly-opponent trust model.
- **(c) Both report independently; a mismatch raises a `DISPUTE` state.** Necessary the moment an organizer is involved (G8).

**Recommendation: (b) for v1**, plus `UNDO_LAST_RESULT` available to either seat until the next round's roll is emitted. §1 already grants friendly opponents; a confirmation step is ceremony that buys nothing against a trusted counterparty, and undo covers the real failure mode, which is a fat finger rather than a lie.

**But model the event as two-sided-capable from day one.** `REPORT_RESULT` should carry a `reportedBy: Seat` and the reducer should tolerate two of them. v1 only ever emits one. If G8 ever resolves toward real tournaments, (c) becomes mandatory, and retrofitting a second reporter into a single-report event schema means migrating logs.

**Also worth stating explicitly as a non-goal:** the app does not simulate, score, or validate the dice game itself. Write that into §1. Its absence is why this gap was invisible.

---

## G13 — The engine has no version, so replay is silently unsound — RESOLVED → D16

§11 non-negotiable 2 snapshots the ruleset and roster version "or past matches replay against rules that no longer exist." Correct instinct, incomplete application. It snapshots the _configuration_ and not the _interpreter_.

D10–D13 just changed `reduce` semantics. Any log written before today replays to a different terminal state now, and nothing in the system would say so — it would simply produce a different answer, confidently.

This directly undermines Phase 5's exit criterion ("export a match, re-import, replay to an identical terminal state"), which is the test that proves event sourcing was actually implemented rather than merely intended. That test is only meaningful if the replaying engine is known to be the writing engine.

**Decisions needed:**

- `engineVersion` (semver) written into the creation event alongside `seed` and `ruleset`
- Replay refuses on **major** mismatch rather than proceeding. Loud, not silent — this is the same principle as the stale-ruleset-hash rule in §12
- `Event` carries a discriminated schema version `v` from the first commit, even while it is always `1`
- A stance on old logs: **do not retain old reducers.** Before there are matches worth preserving, versioned refusal is enough. Revisit if and when a real tournament produces a log someone would argue about

**Related, and cheap to fix now:** §5 references `Event` and `EventTag` as types and defines neither. The event union is the actual contract between engine, Durable Object, log export, and any future replay tool. It deserves to be written out in the spec rather than discovered in the code.

---

## G14 — No validator that a scoring × resolution pair terminates — RESOLVED → §13 (built in Phase 2)

§10 presents `onTie.scoring`, `match.resolution`, and `overtime.enabled` as independent knobs and then shows two hand-picked combinations that happen to work.

Not all combinations do. `HALF_POINT` + `FIRST_TO_2` + `overtime: disabled` reaches 1.5–1.5 after three rounds, with every character consumed and no mechanism to break the deadlock. The loader accepts it happily.

**Decision needed:** a sixth load-time validator asserting that every `(scoring, resolution, overtime)` triple is provably terminating. The legal set is small — four or five combinations — so this is a lookup table, not an analysis. It belongs in the loader for the same reason the other five validators do: a mode that cannot finish should fail at load, never at 1.5–1.5 in front of two players.

---

## Round five — draft count becomes a parameter (2026-07-28)

### D25 — `draftCount` is a mode parameter, not two mode files

Requested as a toggle. Implemented as a **declared parameter** rather than a host-facing choice between `base-bo3` and `base-bo4`, because the two-file version was quietly worse:

- Two files drift. The round loop is identical between them, so every future change to the template has to be made twice and eventually is not.
- Two files hide the comparison. §15 can log which _mode_ was played but not compare like with like; a parameter makes 3-vs-4 a single dimension in one dataset.
- Two files do not generalize. The next toggle (`banCount`, round count) would make it four files, then eight.

The mode declares its own parameter space:

```yaml
parameters:
  draftCount: { values: [3, 4], default: 4, label: 'Characters drafted' }
```

**The load-time guarantee is preserved, and this is the part that mattered.** A parameterized mode could easily have degraded §13's validators from load-time to resolution-time — catching a bad config when a host picks it rather than when it deploys. Instead, a new validator requires **every declared combination** to pass every other validator at load, with the parameter space capped at 32 combinations. A parameterized mode validated only for its defaults is an unvalidated mode.

Two knock-ons worth knowing:

- `Ruleset.parameters` is snapshotted, and `modeContentHash` (D20) covers the resolved parameters as well as the file content. The same mode at `draftCount: 3` and `draftCount: 4` is two different rulesets and must hash differently.
- §12's joiner preview must render parameter values. A host quietly switching 4 → 3 is exactly the change the joiner is consenting to.

### D26 — auto-commit, which is what actually made D25 clean

The naive parameterization needed a conditional: at `draftCount: 3` round 2 uses D13's `forcedSelect`; at 4 it is a real simultaneous pick. That would have put an `if` inside mode config, which is the beginning of the end for "modes are data."

The fix was to notice D13 was stated too narrowly. The rule is not _"round 2 is special."_ It is **"a decision with one option is not a decision."** So `SELECT` auto-commits whenever `|legalRoundPick(seat)| == 1`, emitting a `SYSTEM` event with `reason: FORCED`.

The conditional disappears — **the same YAML serves both parameter values** — and the general rule covers a case nobody had enumerated: at `draftCount: 3`, a round-1 ban already leaves the opponent exactly one option, so that select auto-commits too, removing a click that was never a choice.

No information leaks. The round loop runs only after every reveal gate has fired, so holdings are public by then. Watching an opponent commit instantly tells you they were forced, which you knew, because you placed the ban that forced them.

D13's _principle_ survives intact and its validator still stands guard — `remove` may not delete a slice-writing module. Nothing in the shipped modes uses it that way now, which is the correct end state for a guardrail.

---

## Round four resolutions (2026-07-28)

### G9 → D22 — Four drafted slots

Not for O1's reason. At three slots, **two of three rounds contain no drafting decision** — round 1's ban leaves the opponent exactly one option, and round 2 has no ban and one slot each. A ban/pick tool whose pick phase stops mattering after the opening round has a design problem, not a balance problem.

Three slots also disables a counterweight the spec already contains: R1's `selectOrder` override hands the _opponent_ the last-pick information advantage, deliberately compensating for R1's stronger ban. Against a forced opponent, information is worthless and the counterweight never fires. At four slots it works as written.

D21 compounded it — under `ALWAYS_3_ROUNDS`, round 2 is played in every match except a 2–0, so the decision-free round became the norm rather than an edge case.

Round 2 at four slots is the best round in the design: no privilege, no ban, two unconsumed slots each, simultaneous hidden pick, no information advantage either way. `draftCount: 3` stays available alongside it — **superseded in form by D25**, which makes it a parameter on one file rather than a second mode, and by D26, which replaced `forcedSelect` with general auto-commit. Three remains the only configuration that exercises the auto-commit path in round 2, which is why it stays in the test matrix regardless of which value wins.

Consequence: roster floor moves to `draftCount + 1 = 5`.

### D23, D24 — `TURN_ORDER` is a decision, not a default

The spec never said whether holding `TURN_ORDER` meant _going_ first or _choosing_ who goes first. D2's row was literally titled "Choose who goes first," so the second reading was probably always intended — but probably is not specified.

**D23:** the holder declares `SELF_FIRST` or `OPPONENT_FIRST`. They may put themselves second, which matters in any dice game where knowing the target is worth more than setting it.

**D24:** it is exercised **after both selections are revealed**, immediately before `REPORT_RESULT`. Declaring play order blind is a coin flip with ceremony; declaring it knowing the matchup is a real decision. This also narrows the O5 bundle gap, because it makes `TURN_ORDER` meaningfully more valuable than it read before.

No new module — it is a `CHOOSE` over `[SELF_FIRST, OPPONENT_FIRST]`, which is what `CHOOSE` is for.

### O6 opened — the 75-character roster makes the meta ban blind

The target roster moving from 10 to ~75 does not affect any decision above, but it changes what `bring-ban1` is.

`P(a named character sits among the opponent's 4 picks) = 4/75 ≈ 5.3%` under uniform drafting. A meta ban whiffs about nineteen times in twenty. The mode's stated premise — _"did they bring this, and is my ban worth the trade"_ — assumes you are reading a draft. At 75 you cannot read a draft; there is nothing to read.

**Why it survives anyway:** friends do not draft uniformly. They draft favourites, and after a few sessions you know theirs. The ban becomes a read on the _person_, not the _draft_ — which for casual repeat play is arguably the better mode. It is simply not the one §9.2 describes.

**Two consequences:**

1. §9.2's strategic note and all `bring-ban1` UI copy need rewriting before Phase 4. The honest line is closer to _"what do they always play?"_ than _"did they bring this?"_
2. §15's meta-ban hit rate stops being a curiosity and becomes the metric that decides whether the mode earns its place. If regulars hit above ~30%, metagame knowledge is real and the mode works. If it tracks 5%, the mode is noise with a reveal animation.

**Do not fix this by banning more.** Two bans reach ~10.4%; a coin flip needs roughly 15. The mechanism does not scale, and trying to make it scale would turn a clean mode into a lottery with more steps.

**Also a Phase 4 scope note:** drafting 4 from 75 is a search-and-filter problem, not a grid. Favourites, recents, and text search stop being polish. Phase 1 fixtures should include a synthetic 75-entry roster so scale is exercised before the UI is built.

---

## Round three resolutions (2026-07-28)

### G7 → D20 — Hash cut from the URL

The framing was wrong. The first question was not _how_ to canonicalize but _whether the hash earns its place_, and it does not — in the form the spec described.

§11 snapshots the resolved ruleset into the creation event. A joiner joins an existing match and reads that snapshot, which is immutable by construction. There is nothing to go stale. The URL hash guarded against the joiner's client rendering the preview from its own bundled mode files — which is exactly what §11.4's thin-client rule already forbids. It was a second guarantee layered over a place the first one already covered, and every duplicated guarantee is a place two truths can disagree.

Repurposed rather than deleted: `modeContentHash` hashes the **resolved mode definition content** and lives in the creation event beside `engineVersion` (D16). That catches a real risk the old design missed — you can change the tie rule inside `base-bo3.yaml` and `modeId` never moves, so a replay would silently apply different rules. Same twenty lines, guarding something that was actually unguarded.

### G10 → D21 — `HALF_POINT` only

`COMPENSATION`, `ROLL_OFF`, and `VOID_AND_REPLAY` are all cut. Shipped config is `HALF_POINT` + `ALWAYS_3_ROUNDS` + `stopWhenDecided` + no overtime, and **a 1.5–1.5 draw is a legal terminal state**.

Cutting `COMPENSATION` was not asked for but follows: the `advantageHolder` concept existed solely to answer "who loses a tied round," and `HALF_POINT` does not ask. §10's per-round assignment table and §13's advantage-resolver validator both go with it. Two constructs removed by deleting one rule.

`stopWhenDecided` handles the dead rubber `ALWAYS_3_ROUNDS` would otherwise create. Only a 2–0 score after two rounds is mathematically settled — at 1.5–0.5 a draw is still reachable, so round 3 is played.

The cut is **deferred, not permanent** (unlike D19). §15 measures tie frequency; if ties exceed roughly 15% of rounds the conversation reopens with evidence instead of guesses.

---

## Round two resolutions (2026-07-28)

### G11 → D14 — Roster

Ten placeholder characters shipped at `roster/roster.json`, with `roster/README.md` documenting the replacement rules. `Character = { id, name, blurb, status }`.

The extensibility requirement drove the one non-obvious choice: **`status: 'ACTIVE' | 'RETIRED'` instead of deletion.** Removing a character breaks replay of every match that referenced it — the log holds an ID that no longer resolves, and §14.5's export/replay guarantee (the test that proves event sourcing was real) fails. Retiring costs one field and preserves it permanently. `activeRoster` is what the pool grammar draws from.

Renames are free because `id` is identity and `name` is display. That is what makes "replace them later" cheap rather than a migration.

The escape hatch: no real matches exist yet, so the ten placeholders can be deleted outright and the version reset. That hatch closes at the first real match.

### G12 → D15 — Result reporting

Either seat reports, no confirmation, `UNDO_LAST_RESULT` open to either seat until the next round's roll.

~~**The earlier "keep it two-sided-capable" recommendation is withdrawn.** It existed solely to survive a tournament retrofit, and D19 rules that out. Carrying a second reporter field and a `DISPUTE` state forever, for a scenario that will not occur, is the speculative generality this design otherwise avoids.~~ `reportedBy: Seat` stays for log attribution — that is useful in casual play for its own sake.

> **Struck 2026-08-15 by D38.** The scenario occurred. Two-sided reporting is reinstated for
> matches carrying a tournament binding, along with the `DISPUTE` state, and **D15 is unchanged
> for casual play** — either seat still reports, still without confirmation, still with the undo
> window open until the next roll. That split is the part worth noting: the withdrawal treated
> "two-sided" as a property of the app, and it is a property of the _match_.
>
> The judgement was not wrong at the time. Declining to carry an unused field for four phases was
> right, and paying for it once here is cheaper than having carried it throughout. What was wrong
> was the confidence that the scenario "will not occur" — see G8.

Also written into §17: **the app does not simulate, score, or validate the dice game.** That non-goal was load-bearing and unstated, which is precisely why this gap was invisible through the first review.

### G13 → D16 — Engine versioning

`engineVersion` in the creation event, replay refuses on major mismatch, every event carries `v: 1`. §11's non-negotiables gain a fourth item, because snapshotting config while leaving the interpreter floating is half a snapshot.

`EventEnvelope` is now written out in §5 — `{ v, seq, tag, actor, payload }`. `seq` doubles as the RNG counter key, which is what makes any single roll evaluable without replaying its predecessors.

### G6 → D17 — Session continuity

Refresh, tab close, wifi drop, and device change are all non-events.

Seat token minted at `SEAT_FILLED`, stored in `localStorage` keyed by match ID (so refresh needs no user action) and embedded in a copyable **resume link** (so device change and cleared caches are recoverable). Reconnect presents the token and gets a full `project()` resync — no deltas, no client-side replay.

The resume link is a bearer credential: whoever holds it holds the seat, hidden commits included. Fine under the casual trust model, but it earns one line of UI copy rather than a silent assumption.

Two policies worth flagging because they are the only places the answer is "no":

- **A committed-but-unrevealed action cannot be withdrawn.** Commitment is the entire content of the seal. Allow withdrawal and simultaneous hidden commit becomes take-backsies with extra steps.
- **No forfeit mechanic.** A match left alone simply goes idle and expires at 7 days. Casual play does not need a loss condition for walking away from the table.

### G5 → D18 — Package split

`@banpick/types` for the client, `@banpick/engine` for the Durable Object only, enforced by a dependency rule in CI from the first commit.

The argument is not that the client would compute legality today. It is that if the client _can_, then the first time someone wants a snappier UI, it will — and then two implementations of the rules drift, and §7's redaction guarantee degrades from a property into a promise. Not shipping the code is cheaper than maintaining the discipline.

### G8 → ~~D19~~ → **REOPENED, then D37 (2026-08-15)**

> **G8 is open again.** D19's answer — "no tournament layer, permanently" — was reversed by
> **D37**. The plan is [`TOURNAMENT-PLAN.md`](TOURNAMENT-PLAN.md), and D38–D42 settle the five
> questions it turned on. The original resolution is kept below because its downstream list is
> exactly the bill the reversal has to pay, item by item.
>
> **The lesson worth keeping is about the word, not the judgement.** "Permanently" is not a
> stronger form of "no" — it is a claim about the future that a register cannot make. Everything
> else here was sound: the reasoning was right, the simplifications were real, and reversing it is
> costing precisely what this entry predicted it would.

**D19's original resolution, struck:**

~~**This reverses my earlier advice** to keep the door open with a nullable `eventId` and an organizer-resolvable ruleset. That advice was insurance priced against an unknown. The unknown is now known, and the premium is no longer worth paying.~~

What survives is the **global ban tier**, and it survives D37 too. A host saying "not tonight" is genuinely useful casually and an organizer saying it is useful in a tournament. It was named a _tournament_ ban only because an organizer was assumed to set it; both set it now, and `globalBanned` remains the better name for a mechanism that never cared who chose.

~~Downstream simplifications: no owning entity above a match (room code plus seat token is the permanent identity model, not a provisional one), no `DISPUTE` state, and the bearer-credential resume link moves from _tolerable_ to _appropriate_.~~

**What each of those now costs:**

- **An owning entity above a match** — `TournamentDO`, plus a `tournament` binding snapshotted into the match creation event. Plan Phases 2–3.
- **A `DISPUTE` state** — reinstated by **D38** as a `DISPUTED` slot, for tournament matches only. Casual play keeps D15's single-sided report exactly as written.
- **The bearer-credential resume link** — still appropriate. **D41**'s entrant token makes the same trade a second time, deliberately rather than by inheritance.

### D10 round 2 — confirmed as (a), fresh roll

The question was whether round 2 rolls fresh for turn order (a), inverts a third time (b), or hands turn order to the round-0 roll loser as compensation (c).

**(b) is broken.** Under a third inversion, the round-0 roll winner who takes `TURN_ORDER` ends up holding it in rounds 0 _and_ 2 **plus** the strong round-1 draft privilege (O5). Taking `DRAFT_PRIVILEGE` instead yields the weak round-0 privilege and one turn order. The second option dominates, the roll winner always takes `TURN_ORDER`, and `CHOOSE` becomes theater — precisely the disease D11 removed from round 2.

**(c) looks fairer and is not.** Under (a), the two outcome bundles are identical in content: `{weak DP in R0, TO in R1}` and `{TO in R0, strong DP in R1}`. The roll winner does not _gain_ a bundle — they choose which one to take, and the loser gets the other. So the value of winning the opening roll equals the asymmetry between the two bundles, and nothing more.

That is the number balance work is trying to drive to zero. As the bundles converge, winning the roll approaches worthless — and (c) would then be handing the decider's turn order to the roll loser as compensation for an advantage that no longer exists. **(c) is fair only if the bundles stay lopsided, which is the failure state, not the target.**

(a) keeps round 2 independent of everything before it, which leaves the round-0 choice as the clean question O5 describes.

---

### G14 — Termination validator

A sixth load-time validator added to §13. `HALF_POINT` + `FIRST_TO_2` + `overtime: disabled` reaches 1.5–1.5 with every character consumed and no way to break it. The legal set of triples is small enough to be a lookup table.
