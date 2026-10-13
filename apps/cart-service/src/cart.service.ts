import { randomUUID } from "node:crypto";
import { status } from "@grpc/grpc-js";
import { RpcException } from "@nestjs/microservices";
import type { UserContext } from "@book-shop/common";
import type { cartProto, OrderCreatedPayload } from "@book-shop/contracts";
import {
  guestCartKey,
  userCartKey,
  type CartData,
  type CartItem,
  type CartRepository
} from "./repository";

export interface CartServiceDeps {
  repository: CartRepository;
  /**
   * Sliding TTL (seconds) renewed on every successful cart-touching RPC
   * (spec §2/§3). Env: CART_TTL_SEC.
   */
  cartTtlSec: number;
}

const CART_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cart `amount` serializes as proto int32 — accumulated sums (repeated
 * addItem, guest→user merge) must never exceed the wire bound, else the
 * response encoder's int32 write is undefined behavior.
 */
const MAX_ITEM_AMOUNT = 2147483647;

function rpcError(code: status, message: string): RpcException {
  // RpcException({code, message}) serializes to the matching gRPC status on
  // the wire and exposes `.error.code` / `.getError().code` in-process.
  // The top-level `code` is also set: when several gRPC apps share one
  // process (e2e files under a single `bun test`), the exception can reach
  // grpc-js raw, where the wire status is read from `error.code` directly.
  return Object.assign(new RpcException({ code, message }), { code });
}

/**
 * Domain service surface, fixed by docs/specs/03-cart-service.md §2/§8.
 *
 * `caller` is the already-verified JWT user context — `null` when no valid
 * token was supplied. gRPC `authorization` metadata → `UserContext`
 * (`JwtVerifier` + `RedisTokenDenylist` from `@book-shop/common`) happens in
 * the gRPC controller layer, mirroring auth-service.
 *
 * Owner resolution: a present `cart_id` selects the guest cart (no JWT
 * needed); an absent `cart_id` selects the user cart and requires `caller`,
 * else UNAUTHENTICATED. `MergeCart.guestCartId` is the merge SOURCE — it
 * never switches the request into guest mode; merge always targets the
 * caller's user cart.
 */
export class CartService {
  constructor(private readonly deps: CartServiceDeps) {}

  async createCart(): Promise<cartProto.CreateCartResponse> {
    // Guest carts are lazily materialized — the issued uuid reads as an
    // empty cart until the first mutation (spec §9).
    return { cartId: randomUUID() };
  }

  async getCart(
    request: cartProto.GetCartRequest,
    caller: UserContext | null
  ): Promise<cartProto.Cart> {
    const key = this.resolveKey(request.cartId, caller);
    const found = await this.deps.repository.lookup(key);
    if (found.status === "corrupt") {
      // Consume the unreadable key instead of renewing its sliding TTL —
      // an EXPIRE would keep garbage alive forever. Same "corrupt is
      // consumed" contract as MergeCart (spec F-K1).
      await this.deps.repository.delete(key);
      return this.toProtoCart(null);
    }
    await this.renewTtl(key);
    return this.toProtoCart(found.status === "ok" ? found.cart : null);
  }

  async addItem(
    request: cartProto.AddItemRequest,
    caller: UserContext | null
  ): Promise<cartProto.Cart> {
    const key = this.resolveKey(request.cartId, caller);
    this.requireBookId(request.bookId);
    if (!Number.isInteger(request.amount) || request.amount <= 0) {
      throw rpcError(
        status.INVALID_ARGUMENT,
        "amount must be a positive integer"
      );
    }

    const cart = (await this.deps.repository.get(key)) ?? { items: [] };
    const existing = cart.items.find((item) => item.bookId === request.bookId);
    const amount = (existing?.amount ?? 0) + request.amount;
    if (amount > MAX_ITEM_AMOUNT) {
      // Checked before the write — the stored cart is left untouched.
      throw rpcError(status.INVALID_ARGUMENT, "amount would overflow int32");
    }
    if (existing) {
      existing.amount = amount;
    } else {
      cart.items.push({ bookId: request.bookId, amount });
    }
    await this.deps.repository.set(key, cart, this.deps.cartTtlSec);
    return this.toProtoCart(cart);
  }

  async updateItem(
    request: cartProto.UpdateItemRequest,
    caller: UserContext | null
  ): Promise<cartProto.Cart> {
    const key = this.resolveKey(request.cartId, caller);
    this.requireBookId(request.bookId);
    if (!Number.isInteger(request.amount) || request.amount < 0) {
      throw rpcError(
        status.INVALID_ARGUMENT,
        "amount must be a non-negative integer"
      );
    }

    const cart = await this.deps.repository.get(key);
    const index =
      cart?.items.findIndex((item) => item.bookId === request.bookId) ?? -1;
    if (!cart || index < 0) {
      throw rpcError(
        status.NOT_FOUND,
        `book_id ${request.bookId} is not in the cart`
      );
    }
    if (request.amount === 0) {
      cart.items.splice(index, 1);
    } else {
      cart.items[index].amount = request.amount;
    }
    await this.deps.repository.set(key, cart, this.deps.cartTtlSec);
    return this.toProtoCart(cart);
  }

  async removeItem(
    request: cartProto.RemoveItemRequest,
    caller: UserContext | null
  ): Promise<cartProto.Cart> {
    const key = this.resolveKey(request.cartId, caller);
    this.requireBookId(request.bookId);

    const cart = await this.deps.repository.get(key);
    const index =
      cart?.items.findIndex((item) => item.bookId === request.bookId) ?? -1;
    if (!cart || index < 0) {
      throw rpcError(
        status.NOT_FOUND,
        `book_id ${request.bookId} is not in the cart`
      );
    }
    cart.items.splice(index, 1);
    await this.deps.repository.set(key, cart, this.deps.cartTtlSec);
    return this.toProtoCart(cart);
  }

  async clearCart(
    request: cartProto.ClearCartRequest,
    caller: UserContext | null
  ): Promise<void> {
    const key = this.resolveKey(request.cartId, caller);
    await this.deps.repository.delete(key);
  }

  async mergeCart(
    request: cartProto.MergeCartRequest,
    caller: UserContext | null
  ): Promise<cartProto.Cart> {
    // guest_cart_id is the merge SOURCE — the request always targets the
    // caller's user cart, so a valid JWT is mandatory.
    if (!caller) {
      throw rpcError(status.UNAUTHENTICATED, "a valid JWT is required");
    }
    // Normalize case — Redis keys are case-sensitive, so an uppercased uuid
    // would silently miss the real guest cart.
    const guestId = request.guestCartId?.toLowerCase() ?? "";
    if (!CART_ID_RE.test(guestId)) {
      throw rpcError(status.INVALID_ARGUMENT, "malformed guest_cart_id");
    }

    const userKey = userCartKey(caller.userId);
    const guestKey = guestCartKey(guestId);
    const guestLookup = await this.deps.repository.lookup(guestKey);
    const user = (await this.deps.repository.get(userKey)) ?? { items: [] };
    if (guestLookup.status === "missing") {
      // No guest cart — nothing to merge; renew the user TTL and return.
      await this.renewTtl(userKey);
      return this.toProtoCart(user);
    }
    // An existing guest key is ALWAYS consumed by the merge — a corrupt
    // payload contributes 0 items but the key is still deleted instead of
    // lingering until TTL.
    const merged: CartData = {
      items: user.items.map((item) => ({ ...item }))
    };
    const guestItems =
      guestLookup.status === "ok" ? guestLookup.cart.items : [];
    for (const guestItem of guestItems) {
      const existing = merged.items.find(
        (item) => item.bookId === guestItem.bookId
      );
      const amount = (existing?.amount ?? 0) + guestItem.amount;
      if (amount > MAX_ITEM_AMOUNT) {
        // Checked before the write — the merge is aborted with both carts
        // untouched (the guest key survives for a fixed retry).
        throw rpcError(status.INVALID_ARGUMENT, "amount would overflow int32");
      }
      if (existing) {
        existing.amount = amount;
      } else {
        merged.items.push({ ...guestItem });
      }
    }
    // SET+DEL in one transaction — a crash between them would double-merge
    // on the client's retry.
    await this.deps.repository.setAndDelete(
      userKey,
      merged,
      this.deps.cartTtlSec,
      guestKey
    );
    return this.toProtoCart(merged);
  }

  /**
   * Kafka `order.order.created` handler (spec §4): clears the user cart for
   * `payload.userId`. Internal, unauthenticated, best-effort/idempotent.
   */
  async handleOrderCreated(payload: OrderCreatedPayload): Promise<void> {
    const userId = payload?.userId;
    if (typeof userId !== "string" || userId.length === 0) {
      return;
    }
    await this.deps.repository.delete(userCartKey(userId));
  }

  /**
   * `cart_id` present → guest cart (uuid-validated, no JWT needed);
   * absent → user cart keyed by the verified JWT `sub` (UNAUTHENTICATED
   * without it). Validation failures never reach the repository.
   */
  private resolveKey(
    cartId: string | undefined,
    caller: UserContext | null
  ): string {
    // Presence, not truthiness: a client that sends `cart_id: ""` picked the
    // guest mode and must get INVALID_ARGUMENT, not the user-cart path.
    if (cartId !== undefined && cartId !== null) {
      // Redis keys are case-sensitive — normalize so an uppercased uuid
      // addresses the same guest cart instead of a phantom empty one.
      const normalized = cartId.toLowerCase();
      if (!CART_ID_RE.test(normalized)) {
        throw rpcError(status.INVALID_ARGUMENT, "malformed cart_id");
      }
      return guestCartKey(normalized);
    }
    if (!caller) {
      throw rpcError(status.UNAUTHENTICATED, "a valid JWT is required");
    }
    return userCartKey(caller.userId);
  }

  private requireBookId(bookId: string | undefined): void {
    if (!bookId) {
      throw rpcError(status.INVALID_ARGUMENT, "book_id is required");
    }
  }

  private async renewTtl(key: string): Promise<void> {
    await this.deps.repository.expire(key, this.deps.cartTtlSec);
  }

  private toProtoCart(cart: CartData | null): cartProto.Cart {
    const items: CartItem[] = cart?.items ?? [];
    const result: cartProto.Cart = { items };
    if (items.length > 0) {
      // expires_at reflects the just-renewed sliding TTL; absent for
      // empty/missing carts (spec §2).
      result.expiresAt = {
        seconds: Math.floor(Date.now() / 1000) + this.deps.cartTtlSec,
        nanos: 0
      };
    }
    return result;
  }
}
