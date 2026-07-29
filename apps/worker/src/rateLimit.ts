/// <reference types="@cloudflare/workers-types" />

import type { Seat } from '@banpick/types'

/**
 * Per-seat rate limiting.
 *
 * This is not a defence against a determined attacker — §1's trust model is friendly opponents,
 * and D19 makes that permanent. It is a defence against a **loop**: a client bug, a stuck retry,
 * or a held-down key turning one match into a five-figure DO request count. §11's free-plan
 * table has ~200× headroom for honest play and none at all for a runaway `while (true)`.
 *
 * A token bucket rather than a fixed window, because real play is bursty: a seat sits idle
 * through a draft and then fires four actions in two seconds when a round resolves. A fixed
 * window either rejects that or is too loose to catch a loop.
 *
 * State is per-isolate and deliberately not persisted. Hibernation may reset it, which is the
 * right trade: the cost of forgetting is that a loop gets one extra burst, and the cost of
 * persisting would be a SQLite write on every single message.
 */

const CAPACITY = 20
const REFILL_PER_SECOND = 4

interface Bucket {
  tokens: number
  lastRefillMs: number
}

export class RateLimiter {
  private readonly buckets = new Map<Seat, Bucket>()

  /**
   * `now` is injectable so the tests can advance time without sleeping. In the Worker it comes
   * from `Date.now()`, which is frozen within a request — coarse, and coarse in the safe
   * direction: several actions in one request tick share a timestamp and so cannot refill.
   */
  allow(seat: Seat, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(seat) ?? { tokens: CAPACITY, lastRefillMs: now }

    const elapsedSeconds = Math.max(0, now - bucket.lastRefillMs) / 1000
    bucket.tokens = Math.min(CAPACITY, bucket.tokens + elapsedSeconds * REFILL_PER_SECOND)
    bucket.lastRefillMs = now

    const allowed = bucket.tokens >= 1
    if (allowed) bucket.tokens -= 1

    this.buckets.set(seat, bucket)
    return allowed
  }
}
