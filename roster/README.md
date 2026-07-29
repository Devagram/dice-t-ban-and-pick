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

## Replacing the placeholders wholesale

Since no real matches have been played yet, there are no logs to preserve. Delete all ten, add yours, reset `rosterVersion` to a fresh date. Do this **before** the first real match; after that, rule 2 applies and the escape hatch is gone.

---

## A note on size

**Target is ~75 characters.** The ten here are placeholders.

Roster size is a balance input, and it cuts both ways.

**Too small** and drafting is not private. The §13 floor is `|activeRoster| - |globalBans| >= draftCount + 1`, which is **5** under D22 (4 drafted slots). That is a correctness bound, not a playability one — at 5, each seat drafts 4 of 5 and holdings are effectively public before any reveal.

**Too large and the meta ban goes blind.** At 75 characters and 4 picks, the chance a named character sits in an opponent's draft is `4/75 ≈ 5.3%`. A `bring-ban1` meta ban whiffs roughly nineteen times in twenty under uniform drafting.

That is survivable for the actual use case. Friends do not draft uniformly — they draft favourites, and you know theirs. The ban becomes a read on the _person_ rather than the _draft_, which is a legitimate mode and arguably a better one for casual play. It is just not what the spec's §9.2 copy currently describes. See open item O6.

**Do not compensate with more bans.** Two bans reach about 10.4%; a coin flip would need roughly 15.
