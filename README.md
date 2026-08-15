# dice-t-ban-and-pick

Two-player ban/pick tool for a dice game, with pluggable rulesets.

The design is the primary document — read it before the code:

- [`banpick-design-spec.md`](banpick-design-spec.md) — the spec. Decisions D1–D26, closed.
- [`docs/DELIVERY-PLAN.md`](docs/DELIVERY-PLAN.md) — phased plan and exit criteria.
- [`docs/SPEC-GAPS.md`](docs/SPEC-GAPS.md) — the gap register, all items resolved.
- [`roster/README.md`](roster/README.md) — the three rules that keep replacing characters safe.

**Status:** Phases 1–4 complete — the app is playable end to end. Phase 5 (event log export and
instrumentation) is next, and the plan is right that it is the most valuable deliverable in it.

---

## Layout

```
packages/types/     @banpick/types   — the wire contract. The only package the client imports.
packages/engine/    @banpick/engine  — reduce, legalActions, project. Pure, zero IO.
packages/loader/    @banpick/loader  — mode YAML -> validated, resolved, hashed. Build-time only.
apps/worker/        @banpick/worker  — one Durable Object per match. The authority.
apps/web/           @banpick/web     — the client. Renders PlayerView, posts actions, has no rules.
modes/                               — base.yaml and bring-ban1.yaml. Adding a mode is config.
roster/                              — the versioned character asset, plus a 75-entry fixture.
scripts/                             — the two structural checks CI runs.
```

## Commands

```
npm install
npm run dev          # the whole app on http://127.0.0.1:8787 (build first)
npm run build        # client -> apps/worker/public, served by the Worker
npm run check        # typecheck + lint + boundaries + tests + coverage
npm test             # tests alone
npm run build:modes  # regenerate the worker's mode bundle from modes/*.yaml
npm run deploy       # build, then one wrangler deploy for both halves
```

To play locally: `npm run build && npm run dev`, then open the printed URL in two browsers (one
of them private — seat tokens live in `localStorage`, so two normal tabs share a seat).

## Deploying

```
npx wrangler login   # once, opens a browser
npm run deploy       # builds the client, then one deploy for both halves
```

### From Cloudflare Workers Builds (git integration)

The wrangler config lives in `apps/worker/`, not the repo root, so the deploy command **must**
name it. A bare `npx wrangler deploy` fails with _"The Cloudflare application detection logic
has been run in the root of a workspace"_ — wrangler sees an npm workspace root with no project
in it and refuses to guess.

| Setting        | Value                                               |
| -------------- | --------------------------------------------------- |
| Root directory | `/` (the repo root — the build needs the workspace) |
| Build command  | _(leave empty)_                                     |
| Deploy command | `npm run deploy`                                    |

Root directory stays at `/` because `npm run build` builds `apps/web` through the workspace;
pointing it at `apps/worker` would put the install and the build in the wrong place.

### The admin key (D34)

`/admin` edits recorded results, and the Worker refuses every edit unless a key is configured:

```bash
npx wrangler secret put ADMIN_KEY --config apps/worker/wrangler.jsonc
```

Deliberately **not** in `wrangler.jsonc` — a checked-in key is a key everyone with the repo has.
Until you set one the admin routes answer `503 ADMIN_DISABLED`, which is the safe reading of "not
configured": a deployment nobody has secured has no admin rather than an admin anyone can be.

`/history` needs none of this. It is public and read-only, showing the same rows the standings are
already derived from.

There is no link to `/admin` from anywhere in the app — type the path. Hiding it is not a security
measure (the server's key is), it just keeps a destructive screen out of the way.

**The deploy command must build, not just deploy.** `npm run deploy` is `npm run build &&
wrangler deploy --config apps/worker/wrangler.jsonc` — one field, defined in
[package.json](package.json), so the dashboard cannot drift from the repo. Splitting it across
the Build and Deploy fields also works, but then both have to be right and only one of them
looks wrong when it isn't.

### If a deploy "succeeds" but the site is unchanged

Check the build log for `The directory specified by the assets.directory field does not exist`.

`apps/worker/public/` is **build output and is gitignored**, so a fresh checkout does not
contain it — which is what Cloudflare builds from. A deploy command that skips the build finds
no assets, fails, and leaves the previous version live. The site then looks untouched even
though the commit went through, which reads exactly like a caching problem and is not one.

That prints `https://banpick.<your-subdomain>.workers.dev`. The Durable Object and its SQLite
storage are declared in [wrangler.jsonc](apps/worker/wrangler.jsonc) and provisioned by the
`v1` migration on first deploy — there is nothing to click in the dashboard.

Free plan, verified against current published limits at the start of Phase 3: 100,000
requests/day with **incoming WebSocket messages billed at 20:1**, 5 GB storage. A full match
measures ~60 requests. Hibernation means an idle match costs essentially nothing.

**Renaming the Worker renames the URL.** `name` in `wrangler.jsonc` is the subdomain label;
change it before the first deploy rather than after, since existing room codes are addressed
inside the deployment and resume links embed the origin.

## Duplicate players (D35)

A player id belongs to a **browser**, not a person: `player.ts` generates one on first use, and
D19 settled that there are no accounts to reconcile it against. So the same person on a second
laptop is a second player, appears twice on the leaderboard, and cannot be merged by renaming —
renaming was never what split them. This is a cost of having no logins rather than a bug, which
is why the answer is a way to clean it up afterwards.

`/admin` lists every id with the record attached to it, including ids that claimed a name but
have never finished a match — the shape a returning player's new browser has. Two fixes:

- **Consolidate two ids.** Moves every match from one id onto the other, moves the name claims
  with it, and optionally recaptions the merged history to a single name. Refused with a
  `SELF_MATCH` conflict if the two ids ever played each other, naming the room codes in the way:
  those rows would become a player against themselves, and whether to delete or reassign them is
  a judgement about what actually happened that evening.
- **Reassign one match.** The seat dropdowns on a match row, for a single game played on a
  borrowed laptop rather than an id that is wrong everywhere. The winner follows the seat.

Both rewrite the `matches` rows in place, so the leaderboard, head-to-head, and matchup tables
follow with no recount step — all three are queries over those rows on every read.

The player list is admin-only, but be clear about what that buys: `/api/matches` is public and
every row on it already names both players' ids. The key gates the never-played ids and the
merge itself, not the existence of ids.

## The CI checks, and why they exist

Each of these encodes a guarantee that is a **property** of the build rather than a promise in
a document. That distinction is the whole reason they exist: a rule enforced by discipline is a
rule that holds until the first hurry.

1. **D18 package boundary** (`scripts/check-boundaries.mjs`) — `@banpick/engine` may only be
   imported by the worker and the loader. npm workspaces hoist, so nothing at runtime stops
   anyone importing it anywhere; this script _is_ the boundary. It checks declared dependencies
   **and** actual imports, because hoisting lets those two disagree.
2. **The outbound choke point** (`scripts/check-outbound.mjs`) — exactly one file in the worker
   may call `.send()` or `project()`. §7's redaction is a property of `project()`, and a
   property enforced in two places eventually holds in only one of them.
3. **The no-IO lint** on `packages/engine/src` — bans `node:*`, `fs`, `crypto`, `Date`, and
   `Math.random`. §5 requires the engine to be pure; §11 requires every roll to replay exactly.
   Neither survives an ambient clock or an unseeded random.
4. **Coverage thresholds** — 100% branch on `legalActions` and `project`, ≥90% line overall,
   scoped to `packages/*`. The v8 provider collects nothing from workerd, so the worker's
   assurance is its 41 integration tests in the real runtime rather than a line count. See
   finding F7 in the delivery plan.

## Testing

Three runtimes, because the code runs in three and pretending otherwise is how a "works on my
machine" bug reaches production:

- `packages/*` under **Node**
- `apps/worker` under **workerd**, the runtime Cloudflare deploys — the exit criteria involve
  WebSocket hibernation, SQLite storage, and single-threaded concurrency, none of which a Node
  emulation would test honestly
- `apps/web` under **happy-dom**

The worker's test client has **no access to the engine**. It renders `legalActions` off the
frames it receives, exactly as the real client must (§11.4, D18) — so anything it can do the
real client can do, and anything it cannot is a gap in the protocol rather than in the test.

## The client has no rules

This is the load-bearing property of Phase 4, and it is worth stating plainly: **there is no
client-side validation to disable.** Every control on screen is a rendering of an entry in
`legalActions`; remove the entry and the control disappears with it. `ActionBar.tsx` switches
on the _shape of what arrived_, never on the state of the game, and there is no `if (round ===
2)` anywhere in `apps/web`.

That is what makes §11's thin-client rule real rather than aspirational, and it is why the
client cannot disagree with the server about what is allowed — it has no opinion to disagree
with.

## Where the interesting decisions live in the code

| Question                                               | File                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| Why is the engine a cursor rather than an interpreter? | [`resolveMode.ts`](packages/engine/src/resolveMode.ts)        |
| How does D12 land as a term rather than an `if`?       | [`pools.ts`](packages/engine/src/pools.ts)                    |
| Who emits D26's forced select?                         | [`systemStep.ts`](packages/engine/src/systemStep.ts)          |
| What exactly is redacted, and how?                     | [`project.ts`](packages/engine/src/project.ts)                |
| When is D15's undo actually available?                 | [`undoWindow.ts`](packages/engine/src/undoWindow.ts)          |
| What does a mode file have to prove before it can run? | [`validators.ts`](packages/loader/src/validators.ts)          |
| Why is SHA-256 hand-written here?                      | [`sha256.ts`](packages/loader/src/sha256.ts)                  |
| What can a mode file actually say?                     | [`mode.schema.json`](packages/loader/schema/mode.schema.json) |

## Adding a mode

Write a YAML file in [`modes/`](modes/) and load it. That is the whole procedure — §1 requires
that new modes are config and never engine code, and Phase 2 settled it: both shipped modes
resolve from YAML to programs byte-identical to the ones Phase 1 built in TypeScript.

If a mode you want cannot be expressed, that is a finding about the module boundary and belongs
in `docs/SPEC-GAPS.md`. It is not a reason to edit `@banpick/engine`.
