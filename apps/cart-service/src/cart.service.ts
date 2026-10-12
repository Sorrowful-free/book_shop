import type { UserContext } from "@book-shop/common";
import type { cartProto, OrderCreatedPayload } from "@book-shop/contracts";
import type { CartRepository } from "./repository";

export interface CartServiceDeps {
  repository: CartRepository;
  /**
   * Sliding TTL (seconds) renewed on every successful cart-touching RPC
   * (spec §2/§3). Env: CART_TTL_SEC.
   */
  cartTtlSec: number;
}

const NOT_IMPLEMENTED =
  "cart-service is not implemented yet — contract+tests phase (plan-03)";

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
 *
 * TDD skeleton: every method rejects — `src/cart.service.spec.ts` defines
 * the contract the implementation must satisfy.
 */
export class CartService {
  constructor(private readonly deps: CartServiceDeps) {}

  async createCart(): Promise<cartProto.CreateCartResponse> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getCart(
    _request: cartProto.GetCartRequest,
    _caller: UserContext | null
  ): Promise<cartProto.Cart> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async addItem(
    _request: cartProto.AddItemRequest,
    _caller: UserContext | null
  ): Promise<cartProto.Cart> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async updateItem(
    _request: cartProto.UpdateItemRequest,
    _caller: UserContext | null
  ): Promise<cartProto.Cart> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async removeItem(
    _request: cartProto.RemoveItemRequest,
    _caller: UserContext | null
  ): Promise<cartProto.Cart> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async clearCart(
    _request: cartProto.ClearCartRequest,
    _caller: UserContext | null
  ): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async mergeCart(
    _request: cartProto.MergeCartRequest,
    _caller: UserContext | null
  ): Promise<cartProto.Cart> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /**
   * Kafka `order.order.created` handler (spec §4): clears the user cart for
   * `payload.userId`. Internal, unauthenticated, best-effort/idempotent.
   */
  async handleOrderCreated(_payload: OrderCreatedPayload): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
