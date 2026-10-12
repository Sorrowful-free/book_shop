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

export interface CartRepository {
  /** Read a cart; `null` when the key is missing/expired. */
  get(key: string): Promise<CartData | null>;
  /** Write the whole cart document (last-write-wins, spec §11). */
  set(key: string, cart: CartData): Promise<void>;
  /** Remove the cart document entirely. */
  delete(key: string): Promise<void>;
  /**
   * Sliding TTL refresh (`EXPIRE`). Invoked by the service only after a
   * *successful* operation touching the cart — failures must not renew.
   */
  expire(key: string, ttlSec: number): Promise<void>;
}
