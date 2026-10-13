/**
 * Storage contract for the cart repository (docs/specs/03-cart-service.md §3).
 *
 * Redis layout:
 *   cart:user:{user_id}   → JSON { items: [{book_id, amount}] }   (TTL)
 *   cart:guest:{cart_id}  → JSON { items: [{book_id, amount}] }   (TTL)
 *   cart:order-processed:{order_id} → "1" dedup marker (TTL) — claimed by
 *   the decrement script so an at-least-once redelivery is a no-op.
 *
 *   A decrement that empties the cart DELs the key rather than rewriting
 *   `{"items":{}}` — cjson encodes an empty Lua table as an object, which
 *   is not a valid cart document; missing already reads as an empty cart.
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
 * Dedup marker key for the `order.order.created` consumer — claimed with
 * `SET … NX` inside the decrement script; an existing key means the order
 * was already applied to the cart.
 */
export function orderProcessedKey(orderId: string): string {
  return `cart:order-processed:${orderId}`;
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
   * Atomically decrement positions by purchased amounts
   * (`order.order.created` consumer, spec F-K4): for each `goods` item the
   * position's `amount` decreases; `<= 0` removes the position, a positive
   * remainder stays (units added after checkout belong to the next order).
   * Positions absent from `goods` are untouched; a missing or corrupt key
   * is a no-op (the consumer is best-effort and at-least-once). The write
   * carries the sliding TTL like {@link set}; a cart emptied by the
   * decrement is deleted outright (an empty Lua table can't round-trip
   * through cjson as a JSON array).
   *
   * Deduplicated by `orderId`: the first delivery claims a
   * `cart:order-processed:{orderId}` marker (same TTL) inside the same
   * atomic script, so a redelivery exits before touching positions.
   */
  decrementItems(
    key: string,
    goods: CartItem[],
    ttlSec: number,
    orderId: string
  ): Promise<void>;
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
  /** `EVAL script numKeys key… arg…` — Lua for atomic read-modify-write. */
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}

/**
 * Positional decrement for {@link RedisCartRepository.decrementItems}
 * (spec F-K4). ARGV layout: [1]=dedup marker key, [2]=ttl seconds, then
 * flat bookId/amount pairs. The marker (`SET … NX EX`) makes the consumer
 * idempotent under at-least-once delivery: a redelivered orderId finds
 * the key and returns before touching positions — the marker claim and
 * the decrement are atomic inside the same script. Stored items
 * serialize camelCase (`bookId`) — cjson preserves the rest of the
 * document untouched.
 */
const DECREMENT_ITEMS_LUA = `
if not redis.call("SET", ARGV[1], "1", "NX", "EX", ARGV[2]) then
  return 0
end
local raw = redis.call("GET", KEYS[1])
if not raw then
  return 0
end
local ok, cart = pcall(cjson.decode, raw)
if not ok or type(cart) ~= "table" or type(cart.items) ~= "table" then
  return 0
end
for i = 3, #ARGV - 1, 2 do
  local bookId = ARGV[i]
  local amount = tonumber(ARGV[i + 1])
  if bookId and amount then
    for j = #cart.items, 1, -1 do
      local item = cart.items[j]
      if item.bookId == bookId then
        local remaining = (tonumber(item.amount) or 0) - amount
        if remaining <= 0 then
          table.remove(cart.items, j)
        else
          item.amount = remaining
        end
        break
      end
    end
  end
end
if #cart.items == 0 then
  -- an emptied Lua table would encode back as "items":{} (object), not
  -- [] — delete the key instead; missing reads as an empty cart anyway
  redis.call("DEL", KEYS[1])
else
  redis.call("SET", KEYS[1], cjson.encode(cart), "EX", ARGV[2])
end
return 1
`;

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
      const parsed = JSON.parse(raw) as CartData;
      // Structurally-foreign payload — e.g. `"items":{}` written by an
      // emptied Lua table. It parses fine but isn't a cart; treat as
      // corrupt so readers take their usual consume-and-delete path.
      if (!Array.isArray(parsed?.items)) {
        return { status: "corrupt" };
      }
      return { status: "ok", cart: parsed };
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

  async decrementItems(
    key: string,
    goods: CartItem[],
    ttlSec: number,
    orderId: string
  ): Promise<void> {
    if (goods.length === 0) {
      return;
    }
    // Read-modify-write on the JSON blob must be atomic: a concurrent
    // addItem between a GET and a SET would be silently overwritten. MULTI
    // alone can't express the conditional transform (WATCH would need a
    // retry loop), so the decrement runs as a Lua script. The same script
    // claims the orderId marker first — Kafka delivery is at-least-once,
    // so a redelivery (or a crash between decrement and offset commit)
    // returns early instead of double-decrementing. A missing or corrupt
    // key exits early without mutating — consumed by GetCart's
    // corrupt-cleanup path instead.
    const args: (string | number)[] = [orderProcessedKey(orderId), ttlSec];
    for (const item of goods) {
      args.push(item.bookId, item.amount);
    }
    await this.redis.eval(DECREMENT_ITEMS_LUA, 1, key, ...args);
  }

  async expire(key: string, ttlSec: number): Promise<void> {
    // EXPIRE on a missing key is a Redis no-op — renewing a missing/expired
    // cart is harmless.
    await this.redis.expire(key, ttlSec);
  }
}
