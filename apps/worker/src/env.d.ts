/// <reference types="@cloudflare/workers-types" />

/**
 * The Worker's bindings.
 *
 * Declared inside `namespace Cloudflare` because that is the interface the platform types merge
 * into — `env` from `cloudflare:test` is typed as `Cloudflare.Env`, so a plain global `Env`
 * would be a *different* type that happens to share a name, and every test would see an empty
 * object with no error at the declaration site to explain why.
 *
 * Deliberately one entry long. D19 settled that room code plus seat token is the permanent
 * identity model, so there is no KV for accounts, no D1 for standings, and no queue for
 * provisioning — a match is the largest thing this system knows about.
 */
declare namespace Cloudflare {
  interface Env {
    MATCH: DurableObjectNamespace
    /** D28 — one per pairing, keyed by the two player ids sorted. */
    PAIR_HISTORY: DurableObjectNamespace
  }
}

/** What `DurableObject<Env>` and `ExportedHandler<Env>` refer to. Same type, shorter name. */
type Env = Cloudflare.Env
