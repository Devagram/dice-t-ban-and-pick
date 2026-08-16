# Ban/Pick App: Design Specification

**Status:** Accepted, ready to build
**Date:** 2026-07-28
**Scope:** Two-player real-time ban/pick tool for a dice game, with pluggable rulesets
**Amended:** 2026-07-28 — D10–D26. Round-loop ambiguities closed; roster, result reporting, versioning, session continuity, package boundary, scope, hashing, and tie resolution all decided. See `docs/SPEC-GAPS.md`.
**Reconciled:** 2026-07-28, at the start of Phase 1 — two bugs the later decisions left behind. §5's `SlotIdx` could not address a fourth slot (D25 makes `draftCount` 3 or 4), and §9.2 declared the `draftCount` parameter then hardcoded `count: 4`. §13's transition-preservation wording still described D13's `forcedSelect`, which D26 replaced.

---

## 1. Constraints

| Constraint                   | Value                                                          |
| ---------------------------- | -------------------------------------------------------------- |
| Concurrent players per match | 2                                                              |
| Hosting budget               | $0                                                             |
| Latency requirement          | Human turn-based, sub-second is ample                          |
| Extensibility requirement    | New modes must be config, never engine code                    |
| Trust model                  | Friendly opponents, but hidden phases must be genuinely hidden |

---

## 2. Closed decisions

| #   | Decision                      | Choice                                                                                                                                                                               | Rationale                                                                                                                                                                      |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Roster exclusivity            | Mirrors allowed **across seats only** (see D12)                                                                                                                                      | Drafting denies nothing; bans are the only denial mechanism                                                                                                                    |
| D2  | "Choose who goes first"       | Turn order **in the dice game**, not pick order                                                                                                                                      | Roll winner takes one privilege, loser receives the complement                                                                                                                 |
| D3  | Round ban target              | A specific opponent **slot**, round-scoped                                                                                                                                           | Banner may play the same character they just banned                                                                                                                            |
| D4  | Meta ban target               | Character ID, scoped to **one opponent seat**, match lifetime                                                                                                                        | Opponent-only, so no self-own is possible                                                                                                                                      |
| D5  | Global ban target             | Character ID, **global**, match lifetime                                                                                                                                             | Host-set, public, applies before everything. Renamed from "tournament ban" by D19                                                                                              |
| D6  | Tie handling                  | Both characters are **spent**                                                                                                                                                        | Locks compensation scoring as the natural default                                                                                                                              |
| D7  | Ruleset agreement             | Host picks unilaterally; joiner sees it before seating                                                                                                                               | Locked on `SEAT_FILLED`                                                                                                                                                        |
| D8  | Runtime                       | Cloudflare Workers + Durable Objects, one DO per match                                                                                                                               | Authoritative, single-threaded, free at this volume                                                                                                                            |
| D9  | State model                   | Event-sourced, seeded RNG, per-slice projection                                                                                                                                      | Replayable, disputable, auditable                                                                                                                                              |
| D10 | Privilege sequence            | R0 roll + `CHOOSE` decides. R1 **fully inverts** both privileges, no roll. R2 rolls for turn order only                                                                              | Rounds 0–1 are symmetric by construction; round 2 is a clean decider                                                                                                           |
| D11 | R2 `CHOOSE`                   | Removed. The R2 roll assigns `TURN_ORDER` directly                                                                                                                                   | No draft privilege exists in R2 (§10). A one-real-option `CHOOSE` surfaces a dominated action                                                                                  |
| D12 | Self-duplicate drafts         | **Forbidden.** A seat may not fill two of its own slots with the same `characterId`                                                                                                  | Caps meta ban blast radius at one slot, and makes the §13 roster floor derivable rather than coincidental                                                                      |
| D13 | Final-round selection         | **Generalized by D26.** Principle stands: `remove` may delete a _decision_, never a _state transition_. The round-2 special case it created is gone                                  | A `SELECT` that vanished would leave `consumed` untouched and the replay incomplete                                                                                            |
| D14 | Roster                        | Versioned JSON asset. `Character = { id, name, blurb, status }`. Retire, never delete                                                                                                | IDs appear in every log forever; deletion breaks replay. See §16                                                                                                               |
| D15 | Result reporting              | Either seat reports, no confirmation. `UNDO_LAST_RESULT` open until the next round's roll                                                                                            | Casual play only (D19). A confirm step is ceremony against a trusted counterparty; undo covers the real failure mode, which is a fat finger                                    |
| D16 | Engine versioning             | `engineVersion` (semver) in the creation event. Replay **refuses** on major mismatch. Every event carries `v`                                                                        | Snapshotting config without snapshotting the interpreter makes replay silently wrong                                                                                           |
| D17 | Session continuity            | Seat token minted at `SEAT_FILLED`, held in `localStorage` and embedded in a resume link. Reconnect is a full `project()` resync                                                     | Refresh, tab close, and device change must all be non-events                                                                                                                   |
| D18 | Package split                 | `@banpick/types` → client. `@banpick/engine` → Durable Object only. Enforced in CI                                                                                                   | §11 forbids the client computing legality; shipping it the engine makes that a promise instead of a property                                                                   |
| D19 | Tournament layer              | ~~**Out of scope, permanently.** Casual friendly play only~~ **Reversed by D37 (2026-08-15).** What survives is the identity model: no accounts, nothing crossing devices but a link | Reversed the earlier "keep the door open" advice — see §17. The reasoning held; the word _permanently_ did not, and D37 records what that cost                                 |
| D20 | Ruleset hash                  | **Cut from the join URL.** `modeContentHash` goes in the creation event instead                                                                                                      | The joiner reads the server's snapshot, which cannot go stale. Hashing _mode file content_ catches a real risk the old design missed: editing `base.yaml` never moves `modeId` |
| D22 | ~~Drafted slots fixed at 4~~  | **Superseded by D25.** 4 remains the default                                                                                                                                         | Original rationale still holds and is preserved in §9.3                                                                                                                        |
| D25 | Draft count                   | **`draftCount` is a declared mode parameter**, values `[3, 4]`, default `4`, chosen by the host in the lobby. One mode file, not two                                                 | The 3-vs-4 question is a live balance question. A parameter lets it be A/B tested in the wild instead of argued about                                                          |
| D26 | Forced selection, generalized | `SELECT` **auto-commits when exactly one legal option exists**, emitting a `SYSTEM` event with `reason: FORCED`. Supersedes D13's round-2 special case                               | The rule was never "round 2 is special." It is "a decision with one option is not a decision." Stating it generally removes every conditional override                         |
| D23 | What `TURN_ORDER` grants      | The **right to decide** play order, not automatic first play. Holder declares `SELF_FIRST` or `OPPONENT_FIRST`                                                                       | D2's decision was literally titled "Choose who goes first." The spec never said which reading held. This one                                                                   |
| D24 | When it is exercised          | **After both selections are revealed**, immediately before `REPORT_RESULT`                                                                                                           | Deciding play order knowing the matchup is a real decision; deciding it blind is a coin flip with extra steps. Also narrows the O5 bundle gap                                  |
| D21 | Tie and match resolution      | `HALF_POINT` only. `ALWAYS_3_ROUNDS`, `stopWhenDecided`, ~~no overtime~~ **overtime since D30**. **A 1.5–1.5 draw is a legal terminal state _when nothing is left to play_**         | One rule beats four unproven ones. Cuts `COMPENSATION`, `ROLL_OFF`, `VOID_AND_REPLAY`, and with them the whole `advantageHolder` apparatus                                     |

### D31–D36 — backfilled 2026-08-15

These were decided and built, and never written here. The table said "closed decisions" while six
of them lived only in code comments and the README, which is the failure mode this table exists to
prevent. Recorded now at the depth they warrant; the code comments remain the long form.

| #   | Decision              | Choice                                                                                                                                                                   | Rationale                                                                                                                                                                                     |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D31 | Open lobby list       | Rooms are announced, listed publicly, and swept after 2 hours idle. Anyone who can reach the site can join                                                               | A game should be findable without a link. The room code stops being a secret at that point — it was never much of one, and this records the trade rather than letting it happen quietly       |
| D32 | Rematches             | A finished match can open (or find) its rematch room. Idempotent, so both players pressing it land in one room                                                           | Two players pressing "again" should not produce two rooms each waiting for the other. Seating is still the ordinary lobby flow, because §12.3 makes sitting down the consent                  |
| D33 | In-match amendment    | `AMEND_RESULT` corrects a reported round after the undo window has closed, amending the **event log** so the record follows                                              | D15's undo only reaches the last result. A misreported round two discovered in round three had no path back, and the log is the thing that must stay true                                     |
| D34 | History and admin     | `/history` is public and read-only. `/admin` edits the **stored record** directly, behind `ADMIN_KEY`, failing closed when unset                                         | A match from last month has no log left to amend — its DO expired and the row is all that survives. So this edits the record, can disagree with the log, and is the one thing with a password |
| D35 | Duplicate player ids  | `/admin` lists every player id and can **consolidate two ids** or reassign a single match. Refused when the two ids ever played each other                               | A player id belongs to a browser, not a person (D19's identity model), so a second laptop is a second player. The cost of no logins is paid here rather than pretended away                   |
| D36 | Bo1, and what it cost | `bo1-bring3-ban1`: one round, both seats ban simultaneously, higher roll plays first. **Regulation length and simultaneous bans became engine capabilities to allow it** | §1 promised modes are config, never engine code. It held for everything in that file except two hardcoded assumptions — three rounds, and one banner per round. Both are now mode properties  |

### D37–D43 — the tournament layer, reinstated (2026-08-15)

**D37 reverses D19**, which was recorded as permanent. §17 has been struck accordingly; the
reasoning that made it permanent is preserved there rather than deleted, because a reversed
decision is more useful with its original argument attached than without.

| #   | Decision                                 | Choice                                                                                                                                                                                                                                             | Rationale                                                                                                                                                                                                                                                                                          |
| --- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D37 | Tournament layer                         | **Reinstated.** Brackets, organizers, and match provisioning, in a new pure package plus one Durable Object per tournament. Reverses D19                                                                                                           | D19 priced insurance against an unknown and called the unknown known. It was not. The premium it declined to pay is now owed with interest, and `docs/TOURNAMENT-PLAN.md` itemises it                                                                                                              |
| D38 | Tournament results                       | **Both seats confirm.** Agreeing reports resolve the round; conflicting reports produce a `DISPUTED` slot for the organizer. Casual matches keep D15 unchanged                                                                                     | Reinstates the two-sided-capable schema §17 withdrew _because_ D19 ruled tournaments out. One-sided reporting is right between friends and wrong when it eliminates somebody                                                                                                                       |
| D39 | Consumed results                         | A result that has advanced a bracket slot is **frozen**: no player undo, no D33 amendment. Only the organizer changes it, and doing so re-derives the bracket from the corrected log                                                               | D15, D33 and D34 can all fire after the bracket has moved on. Freezing is the only rule that keeps the bracket and the record from becoming two truths, one of which nobody is looking at                                                                                                          |
| D40 | Grand finals                             | **Bracket reset offered, defaulting to on.** The losers-bracket entrant must win twice                                                                                                                                                             | It is the standard rule and the reason double elimination is fair. A reset match is one more slot to a pure bracket function, so supporting both costs a flag rather than a special case                                                                                                           |
| D41 | Entrant identity                         | A **per-tournament entrant token** authorises the seat; the player id still attributes it. The organizer can re-link an id and re-mint a token                                                                                                     | Gating on the player id would lock an entrant out of their own match the moment they opened it on a phone (D35). The token is D17's trade again: not an account, and losing the browser loses it                                                                                                   |
| D42 | Scale and lifetime                       | **32 entrants**, enforced. Tournaments live **7 days** from last activity. The casual lobby's 2-hour sweep is unchanged                                                                                                                            | One object serialises every write — right at 32, wrong at 500, and said so in the file. The two lifetimes differ because a lobby room is an invitation and a tournament is a commitment spanning evenings                                                                                          |
| D43 | The record that outlives it (2026-08-16) | A **finished** tournament files its final bracket with `RegistryDO`, which has no lifetime. The tournament page falls through to that copy once D42 has swept the object, marked `archived`. Head-to-head counts tournament games and is not split | The bracket is the one thing here that cannot be rebuilt from the matches: they carry no slot ids or edges, and an organizer-resolved slot produced no match at all. Filed only when complete and cleared when a D39 correction unfinishes one, so the archive can never contradict a live bracket |

---

## 3. Open items

| #   | Item                                                                                                                                                                                                                                                                                                                                                       | Status                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | Round 2 privilege is strictly stronger than round 1 (ban leaves opponent 1 option, not 2). Candidate fix: draft 4 per player instead of 3.                                                                                                                                                                                                                 | Measure before fixing. Instrument win rate by privilege role.                                                                                                                                                                                                                                                                 |
| O2  | `BAN_THEN_DRAFT` mode (bans revealed before drafting, no repick needed)                                                                                                                                                                                                                                                                                    | Nearly free once modules exist. Build second.                                                                                                                                                                                                                                                                                 |
| O3  | `MUTUAL` meta ban target for true mirror prevention rather than theft                                                                                                                                                                                                                                                                                      | One line in pool grammar. Leave the door open.                                                                                                                                                                                                                                                                                |
| O4  | ~~`SECONDARY_METRIC` tie-break needs the dice game's own near-miss quantity~~                                                                                                                                                                                                                                                                              | **Closed by D21** — the scoring was cut, so the blocking question no longer has to be answered                                                                                                                                                                                                                                |
| O5  | D10 makes R1's privilege **fully predictable at R0**. Because R1 privilege is the stronger one (O1), the R0 roll winner may now rationally take `TURN_ORDER` in order to inherit `DRAFT_PRIVILEGE` in R1. The R0 choice is no longer "which privilege," it is "sooner and weaker, or later and stronger."                                                  | Feature, not defect — but it inverts the expected sign of the §15 privilege-choice metric. Instrument accordingly before drawing conclusions.                                                                                                                                                                                 |
| O6  | **Resolved better than feared, 2026-07-28.** The real roster is **44**, not the ~75 assumed. `P(a named character sits among the opponent's draft)` is `draftCount/44` — **9.1%** at 4, roughly twice the 5.3% this row was written about. `bring-ban1`'s premise still shifts from reading a draft to knowing an opponent's habits, but far less severely | UI copy was rewritten for the habits framing regardless (Phase 4) and stands — it is the honest question at 10% too. §15's meta-ban hit rate remains the measure of whether the mode earns its place, now against a **9.1% baseline rather than 5.3%**. Still do not compensate by banning more: a coin flip would take eight |

---

## 4. Three ban tiers

These are three distinct primitives with three different key types. Do not collapse them into one type with a scope enum.

| Tier   | Set by                     | Key                         | Lifetime  | Visibility           |
| ------ | -------------------------- | --------------------------- | --------- | -------------------- |
| Global | Host, in ruleset           | `characterId`               | Match     | Public always        |
| Meta   | Each player, hidden commit | `(characterId, targetSeat)` | Match     | Revealed at gate one |
| Round  | Draft privilege holder     | `(seat, slotIndex)`         | One round | Public on placement  |

---

## 5. Domain model

Picks are an **ordered slot array**, not a set. Slots are addressable ban targets and character IDs are not unique within a match once mirrors are allowed.

```ts
type Seat = 'A' | 'B'
type CharId = string
type RoundIdx = 0 | 1 | 2

type SlotIdx = 0 | 1 | 2 | 3 // draftCount is 3 or 4 (D25), so slot 3 is addressable

interface Character {
  id: CharId // permanent. Appears in every log forever. Never reused
  name: string // display only. Free to change
  blurb: string // display only
  status: 'ACTIVE' | 'RETIRED' // retire, never delete (D14, §16)
}

interface Slot {
  index: SlotIdx // stable address; a ban targets this, not the character
  characterId: CharId
  consumed: boolean // spent, including on ties
  bannedInRound: RoundIdx | null
}

interface DraftConstraints {
  crossSeatMirrors: 'ALLOWED' | 'FORBIDDEN' // D1  — ALLOWED
  selfDuplicates: 'ALLOWED' | 'FORBIDDEN' // D12 — FORBIDDEN
}

interface Ruleset {
  modeId: string
  parameters: Record<string, string | number> // D25. Resolved host choices, e.g. { draftCount: 4 }
  rosterVersion: string
  globalBanned: CharId[] // host-set; was `tournamentBanned` (D19)
  constraints: DraftConstraints
  modeContentHash: string // D20. Hash of the RESOLVED MODE DEFINITION *and* the
  // resolved parameters (D25) — same file at draftCount 3
  // and 4 is two different rulesets.
  // Lives in the creation event. Never in a URL
}

interface EventEnvelope {
  v: 1 // event schema version (D16)
  seq: number // append index; also the RNG counter key
  tag: EventTag // stable name, referenced by Slice.revealedBy
  actor: Seat | 'SYSTEM'
  payload: EventPayload // discriminated union, one arm per module
}

interface MatchState {
  ruleset: Ruleset // snapshotted at creation, never dereferenced
  seed: string // snapshotted at creation
  engineVersion: string // snapshotted at creation (D16). Major mismatch refuses replay
  seats: Record<
    Seat,
    {
      slots: Slice<Slot[]>
      metaBanPlaced: Slice<CharId | null>
      score: number
    }
  >
  metaBannedAgainst: Record<Seat, CharId[]> // derived from opponent's ban
  rounds: RoundState[]
  log: EventEnvelope[]
}

interface Slice<T> {
  value: T
  owner: Seat | null // null = public
  revealedBy: EventTag | null // the event that unseals it
}
```

### Engine surface

```ts
reduce(state: MatchState, event: EventEnvelope): MatchState
legalActions(state: MatchState, seat: Seat): Action[]
project(state: MatchState, seat: Seat): PlayerView
```

All three are pure. Zero IO. Shipped as a standalone package imported by both the Durable Object and the client.

---

## 6. Pool grammar

Every draft rule is a set expression over tagged sets, resolved against a seat. Adding a mode should never require new pool code.

```
selfHeld(seat, slotIdx) = { s.characterId | s ∈ seat.slots, s.index ≠ slotIdx }

legalDraftPool(seat, slotIdx)
                        = activeRoster
                        \ ruleset.globalBanned
                        \ match.metaBannedAgainst[seat]
                        \ (constraints.selfDuplicates = FORBIDDEN      // D12
                             ? selfHeld(seat, slotIdx)
                             : ∅)

legalMetaBanPool(seat)  = activeRoster \ ruleset.globalBanned

repickTrigger(seat)     = seat.slots WHERE characterId ∈ match.metaBannedAgainst[seat]

legalRoundBan(seat)     = opponent.slots WHERE !consumed

legalRoundPick(seat)    = seat.slots WHERE !consumed
                                       AND bannedInRound ≠ currentRound
```

Note `legalMetaBanPool` forbids wasting a meta ban on an already globally banned character for free. That is the payoff for keeping bans as set algebra rather than procedures.

D12 lands as one more set difference in `legalDraftPool`, not as a validation pass bolted on afterward. That is the honest test of whether this really is set algebra: a new constraint should be a new term, never a new `if`.

The pool is slot-indexed because it is evaluated per slot inside a `SIMULTANEOUS_COMMIT`, and during a `CONDITIONAL_RECOMMIT` a slot must not exclude the character it currently holds — otherwise a repick of slot 1 would be forbidden from re-selecting what slot 1 already had, which is a different rule than the one D12 states.

---

## 7. Visibility model

Visibility is **per slice**, not per phase. A single phase enum cannot express `bring-ban1`, which has two reveal gates at different times.

```ts
project(state, seat) =>
  mapSlices(state, s =>
    s.owner === null || s.owner === seat || (s.revealedBy && state.log.has(s.revealedBy))
      ? s.value
      : REDACTED)
```

This is the security boundary. The client must never receive a redacted value with a flag; it must receive nothing.

**Required test:** after gate one fires in `bring-ban1`, assert the serialized outbound payload for seat A contains seat B's meta ban and contains zero of seat B's character IDs.

---

## 8. Phase modules

A mode is an ordered list of modules. Each declares the state slices it reads and writes. The format loader fails at load time if a module reads a slice no upstream module writes.

| Module                 | Purpose                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `SIMULTANEOUS_COMMIT`  | Both seats submit hidden, reveal on both-ready. Used by draft, meta ban, and repick. Write this once. |
| `CONDITIONAL_RECOMMIT` | Replace slots matching a trigger predicate, hidden                                                    |
| `REVEAL`               | Unseal named slices                                                                                   |
| `ROLL`                 | Server-side dice with resolution and tie policy                                                       |
| `CHOOSE`               | Actor picks from an option set, loser receives the complement                                         |
| `BAN`                  | Place a ban of a given tier                                                                           |
| `SELECT`               | Commit a slot for the round. **Auto-commits when exactly one legal option exists** (D26)              |
| `REPORT_RESULT`        | Record round outcome, including ties                                                                  |
| `ROUND_LOOP`           | Repeat a template with per-round overrides                                                            |

---

## 9. Mode definitions

### 9.1 Base mode

```yaml
mode: base
label: 'Standard Bo3 — draft ${draftCount}'

parameters: # D25
  draftCount:
    values: [3, 4]
    default: 4
    label: 'Characters drafted'

modules:
  - use: SIMULTANEOUS_COMMIT
    id: draft
    commits:
      picks:
        count: ${draftCount}
        pool: legalDraftPool
        crossSeatMirrors: ALLOWED # D1
        selfDuplicates: FORBIDDEN # D12
    reveal: { picks: IMMEDIATE }

  - use: ROUND_LOOP
    id: rounds
    count: 3
    template:
      - { type: ROLL, dice: 1d6, actors: BOTH, resolve: HIGHEST, onTie: REROLL }
      - {
          type: CHOOSE,
          actor: rollWinner,
          options: [DRAFT_PRIVILEGE, TURN_ORDER],
          loserGets: COMPLEMENT,
        }
      - { type: BAN, tier: ROUND, actor: privilegeHolder, pool: legalRoundBan }
      - { type: SELECT, actor: opponent, pool: legalRoundPick }
      - { type: SELECT, actor: privilegeHolder, pool: legalRoundPick }
      - {
          type: CHOOSE,
          id: declareOrder,
          actor: turnOrderHolder, # D23, D24
          options: [SELF_FIRST, OPPONENT_FIRST],
        }
      - { type: REPORT_RESULT, allowTie: true }
    overrides:
      # D10 — round 1 is the mirror of round 0. No roll: both privileges invert.
      1:
        remove: [ROLL, CHOOSE]
        assign:
          privilegeHolder: '!round0.privilegeHolder'
          turnOrderHolder: '!round0.turnOrderHolder'
        selectOrder: [privilegeHolder, opponent]

      # D11 — no draft privilege exists in round 2, so the roll assigns turn order
      #        directly and CHOOSE is removed rather than narrowed to one option.
      # D26 — no branch on draftCount. At 4 each seat holds 2 unconsumed and picks
      #        for real; at 3 each holds 1, and SELECT auto-commits. Same YAML.
      2:
        remove: [CHOOSE, BAN]
        rollAssigns: TURN_ORDER
        select: { mode: SIMULTANEOUS_HIDDEN, seats: BOTH, pool: legalRoundPick }
```

### Privilege sequence at a glance (D10, D11, D23)

| Round | Roll | Choice                                      | Draft privilege  | Turn order       |
| ----- | ---- | ------------------------------------------- | ---------------- | ---------------- |
| 0     | yes  | winner takes one, loser gets the complement | as chosen        | as chosen        |
| 1     | no   | none                                        | inverted from R0 | inverted from R0 |
| 2     | yes  | none                                        | does not exist   | roll winner      |

In every round, the `TURN_ORDER` holder **declares** play order after both picks are revealed (D23, D24) — they may put themselves second.

Rounds 0 and 1 are exactly symmetric across the two seats, so nothing accumulates. Round 2 is a fresh, symmetric decider. See O5 for what this does to the round-0 decision.

### On `remove` vs `skip`

The original override used `skip`. That word conflates two different operations, and the difference is load-bearing in an event-sourced engine:

- **`remove`** deletes a _decision_ module. Nothing was going to be recorded, so nothing is lost.
- **auto-commit** (D26) handles a _state transition_ whose decision has become trivial. An event is still appended, still authored (by `SYSTEM`), still replayable.

A `SELECT` that simply vanished would leave `consumed` untouched and the replay incomplete. The loader enforces this: `remove` may not name a module that writes a state slice (§13, _transition preservation_).

### Auto-commit (D26) — why there is no `draftCount` branch

D13 originally handled round 2 at three slots with an explicit `forcedSelect` in the override. Parameterizing `draftCount` would have turned that into a conditional — `if draftCount == 3 then forcedSelect else select` — and conditionals inside mode config are the beginning of the end for "modes are data."

The generalization removes it. The rule was never _"round 2 is special"_; it is **"a decision with one option is not a decision."** So:

```
SELECT(seat):
  legal = legalRoundPick(seat)
  if |legal| == 1  → emit SELECT{ actor: SYSTEM, reason: FORCED, slot: legal[0] }
  else             → await the seat's choice
```

The same YAML now covers both parameter values, and it covers cases nobody enumerated: at `draftCount: 3`, a round-1 ban already leaves the opponent exactly one option, so that select auto-commits too — removing a click that was never a choice.

**No information leaks.** The round loop runs only after every reveal gate has fired, so both seats' holdings are already public when auto-commit becomes observable. Seeing an opponent commit instantly tells you they were forced, which you already knew, because you placed the ban that forced them.

### 9.2 Bring N, ban 1

Identical to base, with three modules prepended.

```yaml
mode: bring-ban1
label: 'Bring ${draftCount}, Ban 1'

parameters:
  draftCount: { values: [3, 4], default: 4, label: 'Characters drafted' }

modules:
  - use: SIMULTANEOUS_COMMIT
    id: draft
    commits:
      picks:
        count: ${draftCount} # D25 — was hardcoded 4 while declaring the parameter
        pool: legalDraftPool
        crossSeatMirrors: ALLOWED # D1
        selfDuplicates: FORBIDDEN # D12
      metaBan: { count: 1, pool: legalMetaBanPool, tier: META, targets: OPPONENT_ONLY }
    reveal: { metaBan: IMMEDIATE, picks: DEFERRED } # gate one

  - use: CONDITIONAL_RECOMMIT
    id: repick
    trigger: repickTrigger
    pool: legalDraftPool
    hidden: true

  - use: REVEAL
    id: pickReveal
    slices: [draft.picks, repick.picks] # gate two

  - use: ROUND_LOOP
    # ... identical to base
```

**Sequence:** commit picks and ban (hidden) → gate one reveals bans only → repick banned slots (hidden, conditional) → gate two reveals picks → priority roll.

**Strategic note for UI copy:** an opponent-only meta ban does not prevent a mirror, it steals one. If both players drafted the same character and only one bans it, the banner keeps theirs. The real question the mode asks is "did they bring this, and is my ban worth the trade," not "do I want to avoid this mirror."

### 9.3 Why four is the default, and why three stays available (D22, D25)

Count the rounds that contain a drafting decision.

|     | 3 slots                                 | 4 slots                                       |
| --- | --------------------------------------- | --------------------------------------------- |
| R0  | ban leaves opponent **2** → real choice | ban leaves **3** → real choice                |
| R1  | ban leaves opponent **1** → _forced_    | ban leaves **2** → real choice                |
| R2  | 1 each, no ban → _forced_               | 2 each, no ban → **simultaneous hidden pick** |

At three slots, two of three rounds have no drafting decision in them. That is a larger problem than O1's balance concern — it is a ban/pick tool whose pick phase stops mattering after the opening round.

**Three slots also disables a counterweight this spec already contains.** The R1 override flips `selectOrder` to `[privilegeHolder, opponent]`, handing the _opponent_ the last-pick information advantage as deliberate compensation for R1's stronger ban. When the opponent is forced to their only remaining slot, information is worth nothing and the counterweight is dead on arrival. At four slots it does the job it was written to do.

D21 raises the stakes further: under `ALWAYS_3_ROUNDS`, round 2 is played in every match except a 2–0, so a decision-free final round stops being an edge case and becomes the norm.

Four slots does not eliminate the O1 asymmetry, it narrows it — R1 privilege drops from _total_ (opponent forced, perfect information) to merely strong (opponent has 2). That also pulls the two O5 bundles closer together, which is the balance target.

**Three stays available as a parameter, not a second mode file (D25).** The argument above is reasoning, not evidence, and reasoning about game balance is exactly the thing §15 exists to check. A host-selectable `draftCount` turns a design argument into an A/B test that runs during ordinary play: §15 logs the value, and after enough matches the round-1 win-rate split answers it for real.

`draftCount: 3` is also the only configuration that exercises D26's auto-commit path in round 2, which is worth keeping alive in the test matrix regardless of which value wins.

---

## 10. Tie and match resolution

Ties consume characters (D6). **One rule ships (D21):**

```yaml
onTie: { scoring: HALF_POINT, consumesCharacters: true }
match: { resolution: ALWAYS_3_ROUNDS, stopWhenDecided: true }
overtime: { enabled: true } # ← was `false` until D30
```

A tied round awards 0.5 to each seat. Three rounds are played, the higher score wins, and ~~**1.5–1.5 is a legal terminal state: the match is a draw.**~~ **Amended 2026-08-02 by D30:** 1.5–1.5 is a legal terminal state _only when there is nothing left to play with_. At `draftCount: 4` each seat finishes regulation still holding a character, and those two play an overtime round that decides it. At 3 the sentence stands unchanged. Ties should be rare enough that a drawn match is a curiosity rather than a problem — §15 measures whether that holds.

`stopWhenDecided: true` skips a dead rubber. After two rounds only a 2–0 score is mathematically settled (the trailing seat can reach at most 2–1), so that is the only case it fires. At 1.5–0.5 a draw is still reachable, so round 3 is played.

### What D21 removes

Cutting `COMPENSATION` takes the whole `advantageHolder` apparatus with it — that concept existed solely to answer "who loses a tied round," and `HALF_POINT` does not ask. Gone from §10, and its load-time validator is gone from §13.

`ROLL_OFF` and `VOID_AND_REPLAY` are cut too, but **deferred rather than permanent** — unlike the tournament layer (D19), this is a data-dependent question and §15 already instruments it. Reopen if ties turn out to exceed roughly 15% of rounds.

`VOID_AND_REPLAY` is the one worth being glad about. It was the only rule in the design where `consumed` moves backward, breaking a monotonic invariant that otherwise holds everywhere. Worse, replaying a round forks round _index_ from round _attempt_, and D10's inversion schedule is keyed to index — "round 1 inverts from round 0" has no answer when round 0 was played twice. That is a second dimension in the state model bought for one optional tie rule.

`SECONDARY_METRIC` is moot: it was blocked on O4, and O4 is now closed by not needing an answer.

---

## 11. Runtime architecture

**One Durable Object per match.** Single-threaded execution means simultaneous ready-clicks cannot interleave, and the DO is the authority for all dice and all legality.

**D27 — the concurrency guarantee is also in the data model.** `seq` is the event log's primary key, so two writers who both read a log of length N both try to write `seq = N` and exactly one can win; the loser re-reads and re-_judges_ rather than re-appending, because the opponent's event may have made the action illegal. Under a Durable Object this can never fire — §11's single-threading is what makes simultaneous commits safe, and Phase 3 tests that it holds. It exists because that guarantee currently lives in the **runtime**, and a guarantee that lives in the runtime is one a future deployment decision can remove silently. In the data model it holds on any host that can run two processes, which is every host except this one. Cost: one conditional insert and a bounded retry.

**D28 — the same meta ban may not be brought against the same person two sets running, and that is the first state in this app that outlives a match.** The rule is small; the precedent is not, so it is written down rather than absorbed. **D19 said no tournament layer**, and one honest reading of that was "no persistent player state at all" — this breaks that reading and keeps the rest: identity is a name you type plus an id your browser generates, there are no accounts, no passwords, nothing that crosses devices except the resume link D17 already mints, and the only thing remembered is _the last ban between one pair of players_. ~~Not a history, not a record, not a ranking.~~ **That last clause is superseded by D29 (2026-08-01):** results, head-to-head records and a leaderboard now exist. D28's _mechanism_ is unchanged — the ban rule still keys on the generated id and still reaches the engine only through the log — but its promise that nothing else would be remembered no longer holds, and is struck here rather than quietly outgrown.

Three consequences shaped the implementation, and each is a place this could have gone wrong.

**The engine still never reads anything.** §5 makes `reduce` a pure function of its log and §14.5 turns that into replayability, so a pool that depended on a database lookup would break both — a replay a month later would consult a history that had since moved on and produce a different match. The Durable Object therefore resolves the history and _writes it into the log_ as `PAIRING_RESOLVED`, exactly as `MATCH_CREATED` already snapshots the roster and the ruleset. The engine sees one more set to subtract and knows nothing about where it came from.

**It resolves when the second seat fills, not at creation.** A host opens a room before anyone sits, so at `MATCH_CREATED` there is no pairing to look up. §12.4 already makes the second `SEAT_FILLED` the moment play opens; it is also the first moment the question can be asked, and it is still comfortably before the ban phase, which is the only thing the answer affects.

**The rule is a term, not a branch.** `legalMetaBanPoolExpr` takes the constraints and pushes `DENIED_META_BAN` into the difference when the host has it on — the same test D12's `selfDuplicates` had to pass, and the same reason: a rule expressed as configuration can be turned off, audited, and replayed, while a rule expressed as an `if` inside the evaluator cannot. §13's roster floor moves with it: with the rule on, viability must assume one further character is unavailable, and that check runs at creation before the pairing is known, so it assumes the worst case rather than the actual history.

Names are self-asserted and deliberately unverified — §1's trust model is friendly opponents. The generated id is what the history keys on, so a mistyped name costs a wrong label rather than a bypassed rule; typing someone else's name does not inherit their history.

**D29 — there are standings now, and the boundary moved rather than dissolved.** §17 said "no standings" and D28 said "not a record, not a ranking". Both are amended at their own sites, because a spec that still forbids what the app ships is worse than one that never forbade it.

**What changed and why.** D19's reasoning was about _scheduling apparatus_ — events, organizers, brackets, the resolution paths and nullable fields that come with them. A scoreboard among people who share a deployment link is not that. It is the same group of friends §1 already assumes, keeping track of who is ahead. The premium D19 declined to pay was generality for an unknown use case; this is a known one, asked for after the tool had been played.

**What still holds, and should be quoted back at the next request:** no events, no organizers, no brackets, no scheduling, no seasons, no rating systems. D19 is amended, not repealed.

**A name is now required to sit down, and that is a consequence rather than a preference.** D28 made the name optional on purpose: it was decoration, and a match played identically without one. D29 ended that. An unnamed seat cannot appear on the leaderboard, cannot accumulate a head-to-head, and gives the no-repeat-ban rule nothing to key on — so the same room would apply different rules to the two seats depending on whether one of them typed something. The alternative to requiring a name is a seat that is quietly exempt from a rule the lobby told both players was in force. The client disables the button and the server returns `400 NAME_REQUIRED`, because a disabled button is a suggestion.

**The cost, stated plainly:** you can no longer play a completely anonymous match. Losing the browser still loses the name (§17's trade, unchanged), so this is a low wall rather than an account — but it is a wall, and it was not there before.

**D30 — the level match plays on, when there is something to play with.** D21 accepted 1.5–1.5 as a terminal state, and the argument for it was sound: three rounds against three characters spends the board, so a draw is what is left. `draftCount: 4` quietly falsified the premise. Each seat ends regulation still holding one character, and the match was declaring a draw with the decider face-up in front of both players. A fourth round is played when regulation ends level, using the character each seat held back.

**The condition is the board, not the parameter.** The rule reads "regulation is level _and_ both seats still hold an unconsumed character", so one mode file covers 3 and 4 with no branch and no `if draftCount == 4`. At 3 the second clause is false by the time it is asked and the D21 draw stands untouched. This also means a future mode that spends its characters some other way gets the right answer without anyone remembering it exists — the same reason D12's constraints are set-algebra terms rather than special cases.

**Overtime forbids the tie it exists to break**, and the loader enforces that rather than trusting the mode file. A tiebreaker that can tie ends 2.0–2.0 with an empty board, which is G14's deadlock reached by a longer road. So `HALF_POINT|ALWAYS_3_ROUNDS|true` is in the termination table only alongside a check that the round sets `report: { allowTie: false }`.

**What it is not.** Not a fourth regulation round: it does not exist when regulation separated the players, and it is labelled `OT` rather than `R4` because calling it round four invites the question of why round four is conditional. Not sudden death beyond one round — there is exactly one character each, so one round is all the board can pay for. And it is dropped from the projected view entirely where it cannot be reached, because a strip that shows a round which can never happen is a lie told to the player at `draftCount: 3`.

**The honest cost:** `RoundIdx` grew a fourth value, and every round-shaped assumption in the codebase had to be re-examined against it. That surfaced a real one immediately — `stopWhenDecided`'s `|lead| > roundsRemaining` counts _regulation_ rounds, and folding overtime into that count makes a 2–0 lead look unsettled and drags a dead rubber back onto the board. `ROUND_COUNT` is now the regulation count and the rounds array is longer than it; the two are different questions and the names say so.

Three things this forced, each of which is where it could have gone wrong.

**A name became an identifier, so it has to be ownable.** D28 could leave names unverified because a wrong one cost a wrong label. A ranking makes that a wrong _record_, so names are claimed on first use per deployment and bound to the browser id that claimed them. Still no passwords, and losing the browser still loses the name — the same trade D17 makes for seats, now with a consequence worth stating in the UI rather than discovering.

**Recording had to be idempotent, because D15 lets a finished match un-finish.** Either seat may undo the last result, _including on the final round_, which reopens a completed match — so a match can complete, un-complete, and complete again with a different winner. Results are therefore upserted by room code and the totals derived from what is stored, never incremented. A counter would double-count an undo-then-recomplete and nothing downstream would ever notice, which is the kind of wrong that survives for months.

**It is a scoreboard, not an archive.** Each match keeps its result and the characters drafted, played and banned — about a kilobyte, and enough to answer "what do they always play?", which is the open O6 question about whether the meta ban earns its place. It does _not_ keep the event log: §14.5's export is a separate feature with different retention consequences, and conflating them would decide a data-retention question by accident.

Free plan headroom, verified July 2026 and **re-verified at the start of Phase 3** against the current published limits. Every row held; two are new.

| Resource                                   | Free limit      | A full Bo3 uses                 |
| ------------------------------------------ | --------------- | ------------------------------- |
| DO requests/day (incl. WebSocket messages) | 100,000         | ~60 measured, all sources       |
| Duration                                   | 13,000 GB-s/day | negligible with hibernation     |
| SQLite rows read/day                       | 5,000,000       | a few thousand                  |
| SQLite rows written/day                    | 100,000         | ~35 events, plus seats and keys |
| Storage                                    | 5 GB total      | kilobytes per match             |

Two corrections in our favour, both found during the Phase 3 recheck:

- **Incoming WebSocket messages bill at 20:1** — 100 messages count as 5 requests. The table above assumed 1:1, so the real headroom on the request budget is roughly twenty times what it says. A measured full match spends about 60 requests counting _every_ source, and only its inbound messages get the discount.
- **`rows read` is a separate limit** (5M/day) that the original table missed. It matters here because state is a fold over the event log, so every action re-reads the whole log — quadratic in match length. At ~35 events that is ~600 row reads per match and utterly irrelevant; it is written down because the shape is quadratic and a future longer format would want to notice.

Only the SQLite storage backend is available on the free plan, which is the recommended backend regardless. Serve the client from Cloudflare Pages on the same account.

**Non-negotiables:**

1. Seed the RNG once per match, write the seed into the creation event. Every roll replays exactly.
2. Snapshot the resolved ruleset and roster version into the creation event. Never dereference a mutable ban list at read time, or past matches replay against rules that no longer exist.
3. Snapshot `engineVersion` too (D16). Config without interpreter is half a snapshot: `reduce` semantics change, and a log written before the change replays to a different terminal state with no indication that it did.
4. The client renders `legalActions()` and nothing else. It never computes legality independently — and it is not given the code that could (D18).

---

## 12. Lobby flow

1. Host selects mode, **its parameters** (D25 — e.g. `draftCount: 3` or `4`), and the global ban list. System resolves a `Ruleset` and computes `modeContentHash` over the mode content _and_ the chosen parameters (D20).
2. Room code and join URL carry the room code and nothing else. **The joiner reads the server's snapshot**, which is immutable by construction and therefore cannot be stale — the hash it would have been checked against was guarding a scenario §11.4 already forbids.
3. Joiner sees the fully rendered ruleset (mode name, **parameter values**, global bans, tie rule) **before** taking a seat. Seating is the consent. A host quietly switching from 4 picks to 3 is exactly the kind of change the joiner must see.
4. `SEAT_FILLED` locks the ruleset **and mints a seat token**. Host can abandon and reopen, never edit in place.

### Session continuity (D17)

Refreshing the page must be a non-event. So must closing the tab, losing wifi, and picking the match back up on a different device.

- **Seat token** is minted at `SEAT_FILLED`, returned once, and is the sole credential for that seat.
- Client stores it in `localStorage` keyed by match ID, so a refresh reconnects with no user action at all.
- The same token is embedded in a **resume link**, surfaced in the UI as copyable. That link is what makes device change work, and what rescues a cleared cache.
- Reconnect presents the token and receives a **full `project()` resync**. No deltas, no replay-from-client. The DO is authoritative about what a seat is allowed to know, and a reconnect is just another moment to answer that question.
- The resume link is a bearer credential: whoever holds it holds the seat, including its hidden commits. Acceptable under the casual-play trust model (D19), and worth one line of UI copy rather than a silent assumption.

**Policy:**

| Question                                   | Answer                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Per-action clock                           | None. Casual play                                                                               |
| Idle expiry                                | 7 days, then the DO evicts and the match archives to log-only                                   |
| Withdraw a committed-but-unrevealed action | **No.** Commitment is what makes the seal mean anything                                         |
| Correct a reported result                  | Yes — `UNDO_LAST_RESULT`, either seat, until the next round's roll (D15)                        |
| Abandon                                    | Freely before `SEAT_FILLED`. After, the match simply goes idle and expires. No forfeit mechanic |

---

## 13. Load-time validators

| Validator               | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slice dependency        | Every module's read set is satisfied by an upstream write                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Roster viability        | `\|activeRoster\| - \|globalBans\| >= draftCount + 1` — 4 or 5 depending on the parameter (D25); checked for **both**. See derivation below. Note `activeRoster`: retired characters (§16) do not count                                                                                                                                                                                                                                                                                   |
| Reveal reachability     | Every `revealedBy` tag is emitted by some module in the mode                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Transition preservation | `remove` may not name a module that writes a state slice (D13). D26 removed the need for a forced substitute: a trivial decision auto-commits rather than being removed, so the rule is now unconditional                                                                                                                                                                                                                                                                                 |
| Parameter space         | Every declared parameter combination must pass every other validator **at load time**, and the space must be finite and small. Cap at 32 combinations and fail loudly above it — a parameterized mode that is only validated for its defaults is an unvalidated mode                                                                                                                                                                                                                      |
| Termination             | Every `(scoring, resolution, overtime)` triple must be provably terminating. Two rows since D30, and the second one carries a condition the key cannot express — an enabled overtime round must set `report: { allowTie: false }`, which the validator checks rather than assumes. Note `HALF_POINT` + `FIRST_TO_2` deadlocks at 1.5–1.5 with an empty pool, which is why the pair is not offered; an overtime round that could tie reaches the same deadlock at 2.0–2.0 by a longer road |

### Roster viability, derived

The `>= 4` figure was previously asserted. Under D12 it is derivable, and the derivation matters because the bound changes if D12 ever flips.

Let `N = |activeRoster| - |globalBans|`. Worst case is a seat whose meta ban lands, forcing a repick:

- The seat needs **`draftCount` distinct** characters — 3 or 4 under D25 (D12 forbids self-duplicates)
- One character is unavailable to it (`metaBannedAgainst[seat]`, one ID by `count: 1`)
- Therefore `N - 1 >= draftCount`, so **`N >= 5`** at `draftCount: 4`, and `N >= 4` at `draftCount: 3`. The validator checks the binding case for every declared parameter value, not just the default

Had D12 gone the other way, one legal character could fill every slot and the true bound would be `N >= 2`. Same validator, entirely different number. Encode the derivation in the validator's comment so a future flag flip does not silently leave a stale constant behind.

---

## 14. Build order

1. **Engine package.** Pure, no network, no framework. Test that plays a full match from a scripted event list, at **both** `draftCount` values (D25). Include the O1 asymmetry test explicitly so a future balance change visibly moves it.
2. **Format loader + validators.** Malformed config fails at load, never mid-match.
3. **Durable Object wrapper.** Room code, two seats, seat tokens and reconnect (D17), WebSocket fanout, `project()` at a single outbound choke point.
4. **Client.** Deliberately thin — and given `@banpick/types` only, never `@banpick/engine` (D18).
5. **Event log export.** This is what turns the app from a toy into a balance instrument.

---

## 15. Instrumentation

Log from day one, because the format is unproven:

- **`draftCount` on every match** (D25). Without it the rest of this list is uninterpretable, because 3-pick and 4-pick matches are different games
- Win rate by privilege role, per round index, **split by `draftCount`** (tests O1, and settles §9.3's argument with evidence)
- Meta ban hit rate vs whiff rate. **This is the metric that decides whether `bring-ban1` survives** (O6). Above ~30% among regulars means metagame knowledge is real; tracking near `draftCount/|roster|` means the mode is a coin flip with a reveal animation
- Frequency of mirror drafts, and how often a meta ban steals one
- Tie frequency per round. Two things ride on this: whether `ROLL_OFF` is ever worth reinstating (D21), and how often matches end drawn — `t³ + 1.5·t·(1−t)²`, so a 5% round-tie rate produces roughly 7% drawn matches
- Whether the **round-0** roll winner takes `DRAFT_PRIVILEGE` or `TURN_ORDER`, and win rate for each. Under D10 this is a deferral decision, not a preference one (O5) — a rising `TURN_ORDER` rate is evidence that round-1 privilege is the stronger asset, which is the same claim O1 makes. The two metrics should agree; if they disagree, one of them is measuring something else

**On sample size.** O1 is a claim about _round 1_, and every match has exactly one round 1 — so 20 matches is 20 observations, not 60. At 80% power against a 50/50 null that resolves only a large effect:

| True effect | Matches needed |
| ----------- | -------------- |
| 80 / 20     | ~19            |
| 75 / 25     | ~29            |
| 70 / 30     | ~47            |
| 65 / 35     | ~85            |

Treat 20 matches as a **screening test**: 16+ of 20 is an answer worth acting on, 12 of 20 is nothing. A moderate effect needs ~85 and there is no shortcut.

---

## 16. Roster (D14)

The roster is a versioned JSON asset (`roster/roster.json`), loaded and validated alongside the mode and snapshotted into the creation event. Nothing reads it at runtime. It holds **44 Dice Throne heroes** (Season One, Season Two, Marvel, X-Men, Outcasts, the standalones, and Vanguard), compiled 2026-07-28 — see `roster/README.md` for sources. Vanguard's four release August 2026 and are included ahead of it; a host who does not own that box yet puts them on the global ban list, which is what D5 is for. See _On size_ below, because the number has design consequences.

```
activeRoster = characters WHERE status = 'ACTIVE'
```

`activeRoster` is the `roster` of the §6 pool grammar.

### The three rules that make replacement safe

**1. IDs are identity. Names are not.** `id` appears in every event log ever written. Renaming is free — old logs render the new name, which is correct, because it is the same character. **Never reuse an ID** for a different character: doing so makes every historical log silently wrong with no way to detect it afterward.

**2. Never delete. Retire.** Set `status: 'RETIRED'`. A deleted character breaks replay of every match that referenced it — the log holds an ID that no longer resolves, and §14.5's export/replay guarantee fails. Retiring costs one field and preserves that guarantee permanently.

**3. Bump `rosterVersion` when the draftable set changes.** Adding, retiring, or un-retiring bumps it. Renames and blurb edits do not — cosmetic, ID is identity. Format `YYYY.MM.DD-N`.

### Replacing the placeholders

No real matches have been played, so there are no logs to preserve. Delete all ten, add yours, reset `rosterVersion`. This escape hatch closes permanently at the first real match, after which rule 2 applies.

### On size

Roster size is a balance input, not a data question, and it cuts **both ways**.

**Too small** and drafting is not private. §13's floor of `draftCount + 1` (5 at the default `draftCount: 4`) is a correctness bound, not a playability one: at 5, each seat drafts 4 of 5 and holdings are near-fully known before any reveal, so the meta ban has nothing to discover.

**Too large and the ban goes blind.** The roster is 44. Under uniform drafting, the chance a named character sits among an opponent's 4 picks is `4/44 ≈ 9.1%` — a meta ban whiffs about nine times in ten. That is still nearly twice as good as the ~75 this section was written against, and it makes O6 a milder problem than it looked. See O6.

That does not sink the mode for its actual use case. In casual play against the same few people, nobody drafts uniformly: they draft favourites, and you know what those are. The ban stops being a read on _this_ draft and becomes a read on _this person_. That is a legitimate and arguably better mode for friends — it simply is not the mode §9.2 currently describes, and the UI copy needs to say the true thing.

**Do not compensate with more bans.** At 44, two bans move the hit rate from 9.1% to about 17.5%; reaching even a coin flip would take eight. The shape of the argument is unchanged by the roster being smaller than expected: the mode either runs on metagame knowledge or it does not run.

---

## 17. Scope boundary — ~~D19~~, **reversed by D37 (2026-08-15)**

> **This section is superseded.** D37 reinstates the tournament layer; the plan is
> [`docs/TOURNAMENT-PLAN.md`](docs/TOURNAMENT-PLAN.md). The original text is kept below rather
> than deleted, because the argument it makes is the best available account of what the tournament
> layer costs — and it turned out to be an accurate invoice rather than a wrong prediction. Every
> simplification it lists is a thing that now has to be paid for, and the plan pays for each one
> by name.
>
> What it got wrong was not the reasoning but the word **permanently**. A decision recorded as
> irreversible does not stop the requirement arriving; it only means the reversal has to be
> written down properly when it does. That is what D37 is.

### The original decision, struck

~~**There will be no tournament layer.** No events, no organizers, no brackets.~~ This tool ~~is~~ **was** for casual games between people who know each other.

> **Amended 2026-08-01 by D29.** This sentence read "no brackets, **no standings**" until a leaderboard and match history were added. The standings clause is struck; everything else in it stands. Read D29 before adding to this — the line it draws is between a scoreboard among people who share a link, and the scheduling apparatus D19 rejected.

~~This reverses earlier advice to "keep the door open" with a nullable `eventId` and an organizer-resolvable ruleset. That advice was insurance priced against an unknown. The unknown is now known, and the premium is no longer worth paying~~ — **and that is the sentence to learn from.** The unknown was not known; it was assumed. The insurance D19 declined would have cost two unused fields, and not having it costs the protocol change in D38 and the ruleset-ownership work in Phase 3 of the plan. Cheaper than carrying speculative generality through four phases, on balance — but the trade was real and it is recorded here rather than quietly forgotten.

**What survives, unchanged:** the global ban tier (§4, D5). A host saying "not tonight" is genuinely useful in casual play, and an organizer saying it is useful in a tournament. It was called a _tournament_ ban because an organizer was assumed to set it; both set it now, and the name `globalBanned` still fits better than either. The mechanism earned its place; the name did not.

**What D19 simplified, and what each now costs:**

| D19's simplification                                                                                  | Reinstated by                                                                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `REPORT_RESULT` is single-sided with no `DISPUTE` state (D15), the two-sided-capable schema withdrawn | **D38.** Two-sided for tournament matches only; D15 stands untouched for casual play              |
| No match needs an owning entity above it. Room code plus seat token is the whole identity model       | **D37/D41.** A tournament owns its matches, and an entrant token sits alongside the seat token    |
| The seat token being a bearer credential is acceptable rather than merely tolerable                   | Still acceptable. D41's entrant token makes the same trade deliberately rather than inheriting it |

### The non-goal worth stating outright

**This app does not simulate, score, or validate the dice game itself.** It brackets the game: it decides who bans, who picks, and who goes first, then a human reports what happened. `REPORT_RESULT` is the only place where an unverifiable human claim enters an otherwise fully authoritative system, and that is by design.

That assumption was load-bearing and unwritten, which is why the result-reporting gap stayed invisible through the first review.
