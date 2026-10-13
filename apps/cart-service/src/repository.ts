/**
 * Storage contract for the cart repository (docs/specs/03-cart-service.md §3).
 *
 * Redis layout:
 *   cart:user:{user_id}   → JSON { items: [{book_id, amount}] }   (TTL)
 *   cart:guest:{cart_id}  → JSON { items: [{book_id, amount}] }   (TTL)
 *
 * Unit tests substitute an in-memory implementation; the production
 * implementation is a thin ioredis adapter added by the implementation phase.
 */

/** A single cart line. Raw book_id — enrichment lives at api-gateway. */
export interface CartItem {
  bookId: string;
  amount: number;
}

/** Stored payload behind one cart key. */
export interface CartData {
  items: CartItem[];
}

/** Storage key for a user cart addressed by JWT `sub`. */
export function userCartKey(userId: string): string {
  return `cart:user:${userId}`;
}

/** Storage key for a guest cart addressed by the issued uuid. */
export function guestCartKey(cartId: string): string {
  return `cart:guest:${cartId}`;
}

/**
 * Result of a raw cart read distinguishing the three storage states.
 * The missing/corrupt split matters to readers that consume corrupt keys
 * instead of touching them: MergeCart deletes an existing guest key whose
 * payload no longer parses (corrupt contributes 0 items), GetCart deletes
 * it rather than renewing its sliding TTL.
 */
export type CartLookup =
  | { status: "ok"; cart: CartData }
  | { status: "missing" }
  | { status: "corrupt" };

export interface CartRepository {
  /** Read a cart; `null` when the key is missing/expired/corrupt. */
  get(key: string): Promise<CartData | null>;
  /**
   * Read a cart distinguishing "missing" (key absent/expired) from
   * "corrupt" (key present, payload unparseable). Prefer {@link get} unless
   * the distinction matters — GetCart and MergeCart are the consumers.
   */
  lookup(key: string): Promise<CartLookup>;
  /**
   * Write the whole cart document carrying the sliding TTL in the same
   * command (atomic `SET … EX`, spec §11) — a crash mid-write can never
   * leave a permanent cart.
   */
  set(key: string, cart: CartData, ttlSec: number): Promise<void>;
  /**
   * Atomic `SET setKey … EX ttlSec` + `DEL deleteKey` (MULTI/EXEC) — MergeCart
   * uses it so a crash between the write and the guest-cart delete cannot
   * double-merge on retry.
   */
  setAndDelete(
    setKey: string,
    cart: CartData,
    ttlSec: number,
    deleteKey: string
  ): Promise<void>;
  /** Remove the cart document entirely. */
  delete(key: string): Promise<void>;
  /**
   * Sliding TTL refresh (`EXPIRE`). Invoked by the service only for the
   * read-touch renewal on a key that already carries a TTL — mutations
   * write the TTL atomically via {@link set}.
   */
  expire(key: string, ttlSec: number): Promise<void>;
}

/**
 * Minimal pipeline surface for MULTI/EXEC — matches the subset of the
 * ioredis ChainableCommander the repository uses.
 */
export interface RedisPipeline {
  set(
    key: string,
    value: string,
    expiryMode: "EX",
    seconds: number
  ): RedisPipeline;
  del(...keys: string[]): RedisPipeline;
  exec(): Promise<unknown>;
}

/**
 * Minimal Redis surface the repository needs — any ioredis-compatible client
 * satisfies it (kept narrow so wiring stays explicit and mockable).
 * `set` always carries the TTL (`SET key value EX seconds`) — a bare SET
 * would leave a permanent cart if the process crashed before a follow-up
 * EXPIRE.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    expiryMode: "EX",
    seconds: number
  ): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  multi(): RedisPipeline;
}

/**
 * Production {@link CartRepository} backed by ioredis (spec §3):
 * `GET`/`SET … EX` the JSON cart document, `DEL` to drop it, `EXPIRE` for
 * the read-touch renewal of the sliding TTL. MergeCart's
 * write-user/delete-guest pair runs inside one MULTI/EXEC transaction.
 */
export class RedisCartRepository implements CartRepository {
  constructor(private readonly redis: RedisLike) {}

  async get(key: string): Promise<CartData | null> {
    const result = await this.lookup(key);
    return result.status === "ok" ? result.cart : null;
  }

  async lookup(key: string): Promise<CartLookup> {
    const raw = await this.redis.get(key);
    if (!raw) {
      return { status: "missing" };
    }
    try {
      return { status: "ok", cart: JSON.parse(raw) as CartData };
    } catch {
      // Corrupt payload (e.g. written by an older version) — the key exists
      // but reads as an empty cart; MergeCart still consumes (deletes) it
      // rather than letting it linger until TTL.
      return { status: "corrupt" };
    }
  }

  async set(key: string, cart: CartData, ttlSec: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(cart), "EX", ttlSec);
  }

  async setAndDelete(
    setKey: string,
    cart: CartData,
    ttlSec: number,
    deleteKey: string
  ): Promise<void> {
    const results = (await this.redis
      .multi()
      .set(setKey, JSON.stringify(cart), "EX", ttlSec)
      .del(deleteKey)
      .exec()) as [Error | null, unknown][] | null;
    // exec() resolves per-command [err, result] tuples — a command-level
    // failure doesn't reject the promise; surface it instead of silently
    // dropping, e.g. the guest cart after a failed merge write. A null
    // result means the transaction was aborted entirely (EXECABORT).
    if (results === null) {
      throw new Error("redis transaction aborted");
    }
    const failed = results.find(([error]) => error !== null);
    if (failed?.[0]) {
      throw failed[0];
    }
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async expire(key: string, ttlSec: number): Promise<void> {
    // EXPIRE on a missing key is a Redis no-op — renewing a missing/expired
    // cart is harmless.
    await this.redis.expire(key, ttlSec);
  }
}
