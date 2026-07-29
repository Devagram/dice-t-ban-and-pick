# Roster

`roster.json` is the character set every pool expression in spec §6 draws from. It is a versioned asset, loaded and validated alongside the mode, and snapshotted into each match's creation event. Nothing reads it at runtime.

The ten characters currently in it are **placeholders** (D14). They exist so Phase 1 has something to draft against. Replace them freely — the rules below are what keep replacement from breaking anything.

---

## The three rules

### 1. IDs are permanent identity. Names are not.

`id` is what appears in every event log ever written. `name` and `blurb` are display strings.

- Renaming a character is free. Edit `name`, ship it. Old logs will render the new name, which is correct — it is the same character.
- **Never reuse an ID** for a different character. A reused ID makes every historical log silently wrong, and there is no way to detect it after the fact.

### 2. Never delete. Retire.

Set `"status": "RETIRED"` instead of removing the entry.

A deleted character breaks replay of every match that referenced it — the log holds an ID that no longer resolves, so the export/replay guarantee in §14.5 fails and the match becomes unrenderable. Retiring costs one field and preserves that guarantee permanently.

```
activeRoster = characters WHERE status = 'ACTIVE'
```

`activeRoster` is the `roster` of the pool grammar. Retired characters remain resolvable for display and replay, and are simply never draftable again.

### 3. Bump `rosterVersion` when the _draftable set_ changes.

Format is `YYYY.MM.DD-N`, where `N` increments for multiple changes on one day.

| Change                  | Bump?                         |
| ----------------------- | ----------------------------- |
| Add a character         | **Yes**                       |
| Retire a character      | **Yes**                       |
| Un-retire a character   | **Yes**                       |
| Rename, or edit a blurb | No — cosmetic, ID is identity |
| Reorder the array       | No — order is not meaningful  |

The version goes into the creation event so a past match records which draftable set it was played against.

---

## Adding characters

Append to the array, bump the version:

```json
{
  "id": "new-character-slug",
  "name": "Display Name",
  "blurb": "One line. Shown in the draft UI.",
  "status": "ACTIVE"
}
```

IDs are lowercase kebab-case slugs. Keep them readable — you will be reading them in raw event logs.

## ~~Replacing the placeholders wholesale~~ — **spent, 2026-07-28**

The ten placeholders are gone. `rosterVersion` is now `2026.07.28-3` and the roster holds **44**
Dice Throne heroes — the 40 released, plus Vanguard's four (see below).

**The escape hatch is closed.** From here, rule 2 applies without exception: retire, never
delete, and never reuse an id.

### Sources

Compiled 2026-07-28 from the publisher and secondary sources rather than from memory, because
an id is permanent and a wrong one is unrecoverable:

- Season One and Season Two, and the Marvel eight — [Complete Dice Throne Buyer's Guide](https://www.geeksundergrace.com/tabletop/the-complete-dice-throne-buyers-guide/), corroborated by [Wikipedia](https://en.wikipedia.org/wiki/Dice_Throne)
- X-Men, both boxes — [Marvel X-Men Dice Throne Box 1](https://theop.games/products/marvel-x-men-dice-throne-box-1-iceman-psylocke-storm-wolverine) and the [Battle Chest](https://shop.dicethrone.com/products/marvel-x-men-dice-throne-battle-chest)
- Outcasts, with the publisher's own flavour text — [Outcasts Strongbox](https://shop.dicethrone.com/products/outcasts-strongbox-retail-edition)

- Vanguard — Forgemaster, Duelist, Druid, Sun Elf — [Vanguard Single Heroes](https://shop.dicethrone.com/products/vanguard-single-heroes-minimalist-strongbox) and the [Dice Throne Wiki](https://dice-throne.fandom.com/wiki/Forgemaster). "Forgemaster" is one word in both

### Vanguard is included, and it has not shipped yet

Vanguard releases [August 2026](https://boardgamegeek.com/boardgame/453942/dice-throne-vanguard) — after this roster was written. Its four heroes are `ACTIVE` anyway, which means they are draftable today.

That is deliberate, and it needs no new machinery: **a host who does not own Vanguard yet puts those four on the global ban list.** D5 exists for precisely this — "a host saying 'not tonight' is genuinely useful in casual play" — and "we have not bought that box" is the same sentence.

The alternative would have been a third `status` beyond `ACTIVE` and `RETIRED`. It was not worth it: `RETIRED` means *was* draftable and is the wrong word, and a new state would ripple through the engine, the wire types, and the schema to express something the ban list already says.

---

## A note on size

**The roster is 44.** That is what exists, not a target — and it is materially better for
`bring-ban1` than the ~75 the spec was braced for.

Roster size is a balance input, and it cuts both ways.

**Too small** and drafting is not private. The §13 floor is `|activeRoster| - |globalBans| >= draftCount + 1`, which is **5** under D22 (4 drafted slots). That is a correctness bound, not a playability one — at 5, each seat drafts 4 of 5 and holdings are effectively public before any reveal. At 44 there is no concern here at all, though a host with a long ban list can still walk into it, which is why the lobby re-checks.

**Too large and the meta ban goes blind.** At **44** characters and 4 picks, the chance a named character sits in an opponent's draft is `4/44 ≈ 9.1%` — still roughly **twice** the 5.3% the spec assumed at 75. The ban misses about nine times in ten against a stranger, so the mode is meaningfully less blind than O6 feared.

That is comfortably survivable for the actual use case. Friends do not draft uniformly — they draft favourites, and you know theirs. The ban is a read on the _person_ rather than the _draft_, which is a legitimate mode and arguably a better one for casual play. See open item O6.

**Do not compensate with more bans.** Two bans reach about 17.5%; a coin flip would still need eight.
