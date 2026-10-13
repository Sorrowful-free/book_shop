import { describe, expect, it } from "bun:test";
import { status } from "@grpc/grpc-js";
import type { UserContext } from "@book-shop/common";
import { UserRole, type OrderCreatedPayload } from "@book-shop/contracts";
import { CartService } from "./cart.service";
import type {
  CartData,
  CartItem,
  CartLookup,
  CartRepository,
  RedisLike,
  RedisPipeline
} from "./repository";
import { guestCartKey, RedisCartRepository, userCartKey } from "./repository";

const TTL = 3600;
const INT32_MAX = 2147483647;
const GUEST_ID = "3f6a1d2e-9b8c-4e5a-a7b6-c5d4e3f2a1b0";
const OTHER_GUEST_ID = "8d2c1b0a-4f5e-4d6c-9b8a-7c6d5e4f3a2b";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RepoCall {
  method:
    | "get"
    | "lookup"
    | "set"
    | "setAndDelete"
    | "delete"
    | "decrementItems"
    | "expire";
  key: string;
}

class InMemoryCartRepository implements CartRepository {
  carts = new Map<string, CartData>();
  /** Keys that exist but whose stored payload no longer parses. */
  corruptKeys = new Set<string>();
  /** orderIds already applied — mirrors the Lua `SET … NX` marker. */
  processedOrders = new Set<string>();
  calls: RepoCall[] = [];
  expirations: { key: string; ttlSec: number }[] = [];

  async get(key: string): Promise<CartData | null> {
    this.calls.push({ method: "get", key });
    if (this.corruptKeys.has(key)) {
      return null;
    }
    const cart = this.carts.get(key);
    return cart ? { items: cart.items.map((item) => ({ ...item })) } : null;
  }

  async lookup(key: string): Promise<CartLookup> {
    this.calls.push({ method: "lookup", key });
    if (this.corruptKeys.has(key)) {
      return { status: "corrupt" };
    }
    const cart = this.carts.get(key);
    return cart
      ? {
          status: "ok",
          cart: { items: cart.items.map((item) => ({ ...item })) }
        }
      : { status: "missing" };
  }

  /**
   * Seed a key that exists but is unreadable — mirrors a corrupt Redis
   * payload (`carts.has` still models key existence, `get` reads null).
   */
  setCorrupt(key: string): void {
    this.corruptKeys.add(key);
    this.carts.set(key, { items: [] });
  }

  async set(key: string, cart: CartData, ttlSec: number): Promise<void> {
    this.calls.push({ method: "set", key });
    this.corruptKeys.delete(key);
    this.carts.set(key, { items: cart.items.map((item) => ({ ...item })) });
    // SET carries the TTL atomically — record it like an expiration.
    this.expirations.push({ key, ttlSec });
  }

  async setAndDelete(
    setKey: string,
    cart: CartData,
    ttlSec: number,
    deleteKey: string
  ): Promise<void> {
    // Atomic write+delete (MULTI/EXEC in the Redis implementation).
    this.calls.push({ method: "setAndDelete", key: setKey });
    this.corruptKeys.delete(setKey);
    this.carts.set(setKey, {
      items: cart.items.map((item) => ({ ...item }))
    });
    this.carts.delete(deleteKey);
    this.corruptKeys.delete(deleteKey);
    this.expirations.push({ key: setKey, ttlSec });
  }

  async delete(key: string): Promise<void> {
    this.calls.push({ method: "delete", key });
    this.carts.delete(key);
    this.corruptKeys.delete(key);
  }

  async decrementItems(
    key: string,
    goods: CartItem[],
    ttlSec: number,
    orderId: string
  ): Promise<void> {
    this.calls.push({ method: "decrementItems", key });
    // Mirrors the Lua path: empty goods short-circuits before the script
    // even runs; otherwise the orderId marker is claimed first (a
    // redelivery no-ops), then missing/corrupt keys no-op, and the
    // rewrite carries the sliding TTL.
    if (goods.length === 0) {
      return;
    }
    if (this.processedOrders.has(orderId)) {
      return;
    }
    this.processedOrders.add(orderId);
    if (this.corruptKeys.has(key)) {
      return;
    }
    const cart = this.carts.get(key);
    if (!cart) {
      return;
    }
    for (const item of goods) {
      const index = cart.items.findIndex((i) => i.bookId === item.bookId);
      if (index < 0) {
        continue;
      }
      const remaining = cart.items[index].amount - item.amount;
      if (remaining <= 0) {
        cart.items.splice(index, 1);
      } else {
        cart.items[index].amount = remaining;
      }
    }
    this.expirations.push({ key, ttlSec });
  }

  async expire(key: string, ttlSec: number): Promise<void> {
    this.calls.push({ method: "expire", key });
    this.expirations.push({ key, ttlSec });
  }

  expiresFor(key: string): { key: string; ttlSec: number }[] {
    return this.expirations.filter((e) => e.key === key);
  }

  keysTouched(): string[] {
    return this.calls.map((c) => c.key);
  }
}

function harness(cartTtlSec = TTL) {
  const repository = new InMemoryCartRepository();
  const service = new CartService({ repository, cartTtlSec });
  return { service, repository };
}

const caller = (userId = "user-1"): UserContext => ({
  userId,
  userName: "alice",
  role: UserRole.Customer
});

function grpcCode(error: unknown): number | undefined {
  const err = error as any;
  return err?.code ?? err?.error?.code ?? err?.getError?.()?.code;
}

async function expectGrpcError(
  promise: Promise<unknown>,
  expected: status
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(grpcCode(error)).toBe(expected);
    return;
  }
  expect.unreachable(`expected gRPC error ${status[expected]}`);
}

describe("CartService.createCart", () => {
  it("returns a uuid cart_id for a fresh guest cart", async () => {
    const { service } = harness();
    const res = await service.createCart();
    expect(res.cartId).toMatch(UUID_RE);
  });

  it("issues distinct ids", async () => {
    const { service } = harness();
    const first = await service.createCart();
    const second = await service.createCart();
    expect(second.cartId).not.toBe(first.cartId);
  });

  it("the issued guest cart reads as an empty cart without expires_at", async () => {
    const { service } = harness();
    const { cartId } = await service.createCart();
    const cart = await service.getCart({ cartId }, null);
    expect(cart.items).toEqual([]);
    expect(cart.expiresAt).toBeUndefined();
  });
});

describe("owner resolution (cart_id vs JWT sub)", () => {
  it("cart_id present → guest mode, no JWT required", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: 2 }]
    });

    const cart = await service.getCart({ cartId: GUEST_ID }, null);
    expect(cart.items).toEqual([{ bookId: "b1", amount: 2 }]);
    expect(repository.keysTouched()).toContain(guestCartKey(GUEST_ID));
    expect(
      repository.keysTouched().some((k) => k.startsWith("cart:user:"))
    ).toBe(false);
  });

  it("cart_id present + valid JWT → still the guest cart", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: 2 }]
    });
    repository.carts.set(userCartKey("user-1"), {
      items: [{ bookId: "b9", amount: 9 }]
    });

    const cart = await service.getCart({ cartId: GUEST_ID }, caller("user-1"));
    expect(cart.items).toEqual([{ bookId: "b1", amount: 2 }]);
    expect(repository.keysTouched()).not.toContain(userCartKey("user-1"));
  });

  it("cart_id absent → user cart by JWT sub", async () => {
    const { service, repository } = harness();
    repository.carts.set(userCartKey("user-7"), {
      items: [{ bookId: "b2", amount: 1 }]
    });

    const cart = await service.getCart({}, caller("user-7"));
    expect(cart.items).toEqual([{ bookId: "b2", amount: 1 }]);
    expect(repository.keysTouched()).toContain(userCartKey("user-7"));
  });

  it("cart_id absent + no JWT → UNAUTHENTICATED, storage untouched", async () => {
    const { service, repository } = harness();
    await expectGrpcError(service.getCart({}, null), status.UNAUTHENTICATED);
    expect(repository.calls).toHaveLength(0);
  });

  it("malformed cart_id → INVALID_ARGUMENT (even for a guest)", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.getCart({ cartId: "not-a-uuid" }, null),
      status.INVALID_ARGUMENT
    );
  });

  it("empty cart_id → INVALID_ARGUMENT, not the user-cart path", async () => {
    const { service, repository } = harness();
    // `cart_id: ""` is *present* — it must not fall back to the JWT path
    // (UNAUTHENTICATED) nor silently target a `cart:guest:` key.
    await expectGrpcError(
      service.getCart({ cartId: "" }, null),
      status.INVALID_ARGUMENT
    );
    await expectGrpcError(
      service.addItem({ cartId: "", bookId: "b1", amount: 1 }, null),
      status.INVALID_ARGUMENT
    );
    await expectGrpcError(
      service.updateItem({ cartId: "", bookId: "b1", amount: 1 }, null),
      status.INVALID_ARGUMENT
    );
    await expectGrpcError(
      service.removeItem({ cartId: "", bookId: "b1" }, null),
      status.INVALID_ARGUMENT
    );
    await expectGrpcError(
      service.clearCart({ cartId: "" }, null),
      status.INVALID_ARGUMENT
    );
    // even with a valid JWT an empty cart_id stays INVALID_ARGUMENT
    await expectGrpcError(
      service.getCart({ cartId: "" }, caller("user-1")),
      status.INVALID_ARGUMENT
    );
    expect(repository.calls).toHaveLength(0);
  });

  it("an uppercased cart_id addresses the same guest cart", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: 2 }]
    });

    const cart = await service.getCart(
      { cartId: GUEST_ID.toUpperCase() },
      null
    );
    expect(cart.items).toEqual([{ bookId: "b1", amount: 2 }]);
    // the normalized lowercase key was used, no phantom uppercase cart
    expect(repository.keysTouched()).toContain(guestCartKey(GUEST_ID));
    expect(
      repository.keysTouched().includes(guestCartKey(GUEST_ID.toUpperCase()))
    ).toBe(false);
  });

  it("MergeCart.guest_cart_id is a merge SOURCE, not an owner selector", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: 1 }]
    });
    // still UNAUTHENTICATED without a JWT — the request is always user-mode
    await expectGrpcError(
      service.mergeCart({ guestCartId: GUEST_ID }, null),
      status.UNAUTHENTICATED
    );
    // and the guest cart must not have been touched/deleted
    expect(repository.carts.has(guestCartKey(GUEST_ID))).toBe(true);
  });
});

describe("CartService.getCart", () => {
  it("reads a missing/expired cart as an empty cart (not an error)", async () => {
    const { service } = harness();
    const cart = await service.getCart({ cartId: GUEST_ID }, null);
    expect(cart.items).toEqual([]);
    expect(cart.expiresAt).toBeUndefined();
  });

  it("consumes a corrupt cart key instead of renewing its TTL", async () => {
    const { service, repository } = harness();
    const key = guestCartKey(GUEST_ID);
    repository.setCorrupt(key);

    const cart = await service.getCart({ cartId: GUEST_ID }, null);
    expect(cart.items).toEqual([]);
    expect(cart.expiresAt).toBeUndefined();

    // corrupt payloads read as empty AND self-heal — renewing the sliding
    // TTL would let an unreadable key linger forever
    expect(repository.corruptKeys.has(key)).toBe(false);
    expect(repository.carts.has(key)).toBe(false);
    expect(repository.expiresFor(key)).toEqual([]);
    expect(
      repository.calls.some((c) => c.method === "delete" && c.key === key)
    ).toBe(true);
  });
});

describe("CartService.addItem", () => {
  it("creates a new position", async () => {
    const { service } = harness();
    const cart = await service.addItem(
      { cartId: GUEST_ID, bookId: "b1", amount: 2 },
      null
    );
    expect(cart.items).toEqual([{ bookId: "b1", amount: 2 }]);
  });

  it("sums amount when the book is already in the cart", async () => {
    const { service } = harness();
    await service.addItem({ cartId: GUEST_ID, bookId: "b1", amount: 2 }, null);
    const cart = await service.addItem(
      { cartId: GUEST_ID, bookId: "b1", amount: 3 },
      null
    );
    expect(cart.items).toEqual([{ bookId: "b1", amount: 5 }]);
  });

  it("accumulates different books as separate positions", async () => {
    const { service } = harness();
    await service.addItem({ cartId: GUEST_ID, bookId: "b1", amount: 1 }, null);
    const cart = await service.addItem(
      { cartId: GUEST_ID, bookId: "b2", amount: 4 },
      null
    );
    expect(cart.items).toHaveLength(2);
    expect(cart.items).toContainEqual({ bookId: "b1", amount: 1 });
    expect(cart.items).toContainEqual({ bookId: "b2", amount: 4 });
  });

  it("keeps guest and user carts isolated", async () => {
    const { service } = harness();
    await service.addItem({ cartId: GUEST_ID, bookId: "b1", amount: 1 }, null);
    await service.addItem({ bookId: "b2", amount: 2 }, caller("user-1"));

    const guest = await service.getCart({ cartId: GUEST_ID }, null);
    expect(guest.items).toEqual([{ bookId: "b1", amount: 1 }]);
    const user = await service.getCart({}, caller("user-1"));
    expect(user.items).toEqual([{ bookId: "b2", amount: 2 }]);
  });

  it.each([0, -3])(
    "rejects amount %i with INVALID_ARGUMENT",
    async (amount) => {
      const { service } = harness();
      await expectGrpcError(
        service.addItem({ cartId: GUEST_ID, bookId: "b1", amount }, null),
        status.INVALID_ARGUMENT
      );
    }
  );

  it("rejects a malformed cart_id with INVALID_ARGUMENT", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.addItem({ cartId: "bad", bookId: "b1", amount: 1 }, null),
      status.INVALID_ARGUMENT
    );
  });

  it("rejects an empty book_id with INVALID_ARGUMENT", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.addItem({ cartId: GUEST_ID, bookId: "", amount: 1 }, null),
      status.INVALID_ARGUMENT
    );
  });

  it("requires a JWT for the user cart (UNAUTHENTICATED)", async () => {
    const { service, repository } = harness();
    await expectGrpcError(
      service.addItem({ bookId: "b1", amount: 1 }, null),
      status.UNAUTHENTICATED
    );
    expect(repository.calls).toHaveLength(0);
  });

  it("rejects an accumulated amount over int32 max without mutating the cart", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: INT32_MAX }]
    });
    await expectGrpcError(
      service.addItem({ cartId: GUEST_ID, bookId: "b1", amount: 1 }, null),
      status.INVALID_ARGUMENT
    );
    // cart untouched — the check happens before the repository write
    expect(repository.carts.get(guestCartKey(GUEST_ID))!.items).toEqual([
      { bookId: "b1", amount: INT32_MAX }
    ]);
    expect(
      repository.calls.some(
        (c) => c.method === "set" || c.method === "setAndDelete"
      )
    ).toBe(false);
  });

  it("allows accumulating up to exactly int32 max", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: INT32_MAX - 2 }]
    });
    const cart = await service.addItem(
      { cartId: GUEST_ID, bookId: "b1", amount: 2 },
      null
    );
    expect(cart.items).toEqual([{ bookId: "b1", amount: INT32_MAX }]);
  });
});

describe("CartService.updateItem", () => {
  it("sets the absolute amount (not a sum)", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: 2 }]
    });
    const cart = await service.updateItem(
      { cartId: GUEST_ID, bookId: "b1", amount: 7 },
      null
    );
    expect(cart.items).toEqual([{ bookId: "b1", amount: 7 }]);
  });

  it("amount = 0 removes the position (RemoveItem equivalent)", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [
        { bookId: "b1", amount: 2 },
        { bookId: "b2", amount: 1 }
      ]
    });
    const cart = await service.updateItem(
      { cartId: GUEST_ID, bookId: "b1", amount: 0 },
      null
    );
    expect(cart.items).toEqual([{ bookId: "b2", amount: 1 }]);
  });

  it("returns NOT_FOUND for a missing position", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: 2 }]
    });
    await expectGrpcError(
      service.updateItem({ cartId: GUEST_ID, bookId: "bX", amount: 1 }, null),
      status.NOT_FOUND
    );
    // position untouched
    expect(repository.carts.get(guestCartKey(GUEST_ID))!.items).toEqual([
      { bookId: "b1", amount: 2 }
    ]);
  });

  it("returns NOT_FOUND on a missing cart too", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.updateItem({ cartId: GUEST_ID, bookId: "b1", amount: 1 }, null),
      status.NOT_FOUND
    );
  });

  it("rejects a negative amount with INVALID_ARGUMENT", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.updateItem({ cartId: GUEST_ID, bookId: "b1", amount: -1 }, null),
      status.INVALID_ARGUMENT
    );
  });
});

describe("CartService.removeItem", () => {
  it("removes the position", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [
        { bookId: "b1", amount: 2 },
        { bookId: "b2", amount: 1 }
      ]
    });
    const cart = await service.removeItem(
      { cartId: GUEST_ID, bookId: "b1" },
      null
    );
    expect(cart.items).toEqual([{ bookId: "b2", amount: 1 }]);
  });

  it("returns NOT_FOUND for a missing position", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.removeItem({ cartId: GUEST_ID, bookId: "bX" }, null),
      status.NOT_FOUND
    );
  });

  it("rejects a malformed cart_id with INVALID_ARGUMENT", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.removeItem({ cartId: "nope", bookId: "b1" }, null),
      status.INVALID_ARGUMENT
    );
  });
});

describe("CartService.clearCart", () => {
  it("empties the cart", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: 2 }]
    });
    await service.clearCart({ cartId: GUEST_ID }, null);
    const cart = await service.getCart({ cartId: GUEST_ID }, null);
    expect(cart.items).toEqual([]);
  });

  it("is idempotent — clearing a missing cart succeeds", async () => {
    const { service } = harness();
    await service.clearCart({ cartId: GUEST_ID }, null);
    await service.clearCart({ cartId: GUEST_ID }, null);
  });

  it("requires a JWT for the user cart (UNAUTHENTICATED)", async () => {
    const { service } = harness();
    await expectGrpcError(service.clearCart({}, null), status.UNAUTHENTICATED);
  });
});

describe("CartService.mergeCart", () => {
  it("sums guest positions into the user cart and deletes the guest cart", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [
        { bookId: "b1", amount: 2 },
        { bookId: "b2", amount: 3 }
      ]
    });
    repository.carts.set(userCartKey("user-1"), {
      items: [{ bookId: "b1", amount: 1 }]
    });

    const cart = await service.mergeCart(
      { guestCartId: GUEST_ID },
      caller("user-1")
    );
    expect(cart.items).toHaveLength(2);
    expect(cart.items).toContainEqual({ bookId: "b1", amount: 3 });
    expect(cart.items).toContainEqual({ bookId: "b2", amount: 3 });
    // guest cart deleted, positions live under the user key
    expect(repository.carts.has(guestCartKey(GUEST_ID))).toBe(false);
    expect(repository.carts.get(userCartKey("user-1"))!.items).toHaveLength(2);
  });

  it("a missing guest cart is a no-op success", async () => {
    const { service, repository } = harness();
    repository.carts.set(userCartKey("user-1"), {
      items: [{ bookId: "b1", amount: 1 }]
    });
    const cart = await service.mergeCart(
      { guestCartId: OTHER_GUEST_ID },
      caller("user-1")
    );
    expect(cart.items).toEqual([{ bookId: "b1", amount: 1 }]);
  });

  it("deletes an existing-but-corrupt guest cart (0 items merged)", async () => {
    const { service, repository } = harness();
    repository.setCorrupt(guestCartKey(GUEST_ID));
    repository.carts.set(userCartKey("user-1"), {
      items: [{ bookId: "b1", amount: 1 }]
    });

    const cart = await service.mergeCart(
      { guestCartId: GUEST_ID },
      caller("user-1")
    );
    // corrupt payload contributes 0 items — the user cart is unchanged
    expect(cart.items).toEqual([{ bookId: "b1", amount: 1 }]);
    // but the key existed, so the merge transaction consumed it
    expect(repository.carts.has(guestCartKey(GUEST_ID))).toBe(false);
    const atomic = repository.calls.filter(
      (c) => c.method === "setAndDelete" && c.key === userCartKey("user-1")
    );
    expect(atomic).toHaveLength(1);
  });

  it("rejects a merge whose sum overflows int32 — both carts untouched", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: INT32_MAX }]
    });
    repository.carts.set(userCartKey("user-1"), {
      items: [{ bookId: "b1", amount: 1 }]
    });

    await expectGrpcError(
      service.mergeCart({ guestCartId: GUEST_ID }, caller("user-1")),
      status.INVALID_ARGUMENT
    );
    // merge aborted before the write: the guest key survives so a
    // corrected retry can still merge; the user cart is unchanged.
    expect(repository.carts.has(guestCartKey(GUEST_ID))).toBe(true);
    expect(repository.carts.get(userCartKey("user-1"))!.items).toEqual([
      { bookId: "b1", amount: 1 }
    ]);
    expect(repository.calls.some((c) => c.method === "setAndDelete")).toBe(
      false
    );
  });

  it("merges into an empty user cart fine", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: 4 }]
    });
    const cart = await service.mergeCart(
      { guestCartId: GUEST_ID },
      caller("fresh-user")
    );
    expect(cart.items).toEqual([{ bookId: "b1", amount: 4 }]);
  });

  it("rejects a malformed guest_cart_id with INVALID_ARGUMENT", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.mergeCart({ guestCartId: "not-a-uuid" }, caller()),
      status.INVALID_ARGUMENT
    );
  });

  it("merges via a single atomic setAndDelete call", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: 1 }]
    });

    await service.mergeCart({ guestCartId: GUEST_ID }, caller("user-1"));
    const atomic = repository.calls.filter(
      (c) => c.method === "setAndDelete" && c.key === userCartKey("user-1")
    );
    expect(atomic).toHaveLength(1);
    // no separate SET/DEL pair for the user/guest keys
    expect(
      repository.calls.some((c) => c.method === "set" || c.method === "delete")
    ).toBe(false);
    expect(repository.expiresFor(userCartKey("user-1"))).toHaveLength(1);
  });

  it("uppercased guest_cart_id merges the real guest cart", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: 1 }]
    });

    const cart = await service.mergeCart(
      { guestCartId: GUEST_ID.toUpperCase() },
      caller("user-1")
    );
    expect(cart.items).toEqual([{ bookId: "b1", amount: 1 }]);
    expect(repository.carts.has(guestCartKey(GUEST_ID))).toBe(false);
  });
});

describe("sliding TTL", () => {
  it("renews the TTL on a successful GetCart", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: 1 }]
    });
    await service.getCart({ cartId: GUEST_ID }, null);
    const exp = repository.expiresFor(guestCartKey(GUEST_ID));
    expect(exp).toHaveLength(1);
    expect(exp[0].ttlSec).toBe(TTL);
  });

  it("renews the TTL on a successful mutation and reports expires_at", async () => {
    const { service, repository } = harness();
    const cart = await service.addItem(
      { cartId: GUEST_ID, bookId: "b1", amount: 1 },
      null
    );
    expect(repository.expiresFor(guestCartKey(GUEST_ID))).toHaveLength(1);

    const nowSec = Math.floor(Date.now() / 1000);
    expect(cart.expiresAt).toBeDefined();
    expect(cart.expiresAt!.seconds).toBeGreaterThanOrEqual(nowSec + TTL - 10);
    expect(cart.expiresAt!.seconds).toBeLessThanOrEqual(nowSec + TTL + 10);
  });

  it("renews the user key (not a guest key) for JWT carts", async () => {
    const { service, repository } = harness();
    await service.addItem({ bookId: "b1", amount: 1 }, caller("user-9"));
    expect(repository.expiresFor(userCartKey("user-9"))).toHaveLength(1);
    expect(
      repository.expirations.some((e) => e.key.startsWith("cart:guest:"))
    ).toBe(false);
  });

  it("does NOT renew the TTL on a failed op (NOT_FOUND)", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: 1 }]
    });
    await expectGrpcError(
      service.updateItem({ cartId: GUEST_ID, bookId: "bX", amount: 5 }, null),
      status.NOT_FOUND
    );
    expect(repository.expiresFor(guestCartKey(GUEST_ID))).toHaveLength(0);
  });

  it("does NOT renew the TTL on a failed op (INVALID_ARGUMENT)", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: 1 }]
    });
    await expectGrpcError(
      service.addItem({ cartId: GUEST_ID, bookId: "b1", amount: 0 }, null),
      status.INVALID_ARGUMENT
    );
    expect(repository.expiresFor(guestCartKey(GUEST_ID))).toHaveLength(0);
  });

  it("does NOT touch storage at all on UNAUTHENTICATED", async () => {
    const { service, repository } = harness();
    await expectGrpcError(
      service.addItem({ bookId: "b1", amount: 1 }, null),
      status.UNAUTHENTICATED
    );
    expect(repository.calls).toHaveLength(0);
  });
});

describe("CartService.handleOrderCreated (order.order.created → decrement purchased positions, F-K4)", () => {
  const payload = (
    userId: string,
    goods: OrderCreatedPayload["goods"] = []
  ): OrderCreatedPayload => ({
    orderId: "order-1",
    userId,
    goods,
    totalPrice: 0
  });
  const good = (bookId: string, amount: number) => ({
    bookId,
    bookName: "b",
    author: "a",
    price: 1,
    amount
  });

  it("removes a fully purchased position, keeps the rest", async () => {
    const { service, repository } = harness();
    repository.carts.set(userCartKey("user-5"), {
      items: [
        { bookId: "b1", amount: 2 },
        { bookId: "b2", amount: 1 }
      ]
    });
    await service.handleOrderCreated(payload("user-5", [good("b1", 2)]));
    expect(repository.carts.get(userCartKey("user-5"))?.items).toEqual([
      { bookId: "b2", amount: 1 }
    ]);
  });

  it("decrements a partially purchased position (post-checkout additions survive)", async () => {
    const { service, repository } = harness();
    repository.carts.set(userCartKey("user-5"), {
      items: [{ bookId: "b1", amount: 3 }]
    });
    await service.handleOrderCreated(payload("user-5", [good("b1", 2)]));
    expect(repository.carts.get(userCartKey("user-5"))?.items).toEqual([
      { bookId: "b1", amount: 1 }
    ]);
  });

  it("removes the position when the ordered amount exceeds the cart amount", async () => {
    const { service, repository } = harness();
    repository.carts.set(userCartKey("user-5"), {
      items: [{ bookId: "b1", amount: 2 }]
    });
    await service.handleOrderCreated(payload("user-5", [good("b1", 5)]));
    expect(repository.carts.get(userCartKey("user-5"))?.items).toEqual([]);
  });

  it("is a no-op success when the user cart is absent", async () => {
    const { service } = harness();
    await service.handleOrderCreated(payload("no-such-user", [good("b1", 1)]));
  });

  it("is a no-op when goods is empty or malformed", async () => {
    const { service, repository } = harness();
    repository.carts.set(userCartKey("user-5"), {
      items: [{ bookId: "b1", amount: 1 }]
    });
    await service.handleOrderCreated(payload("user-5"));
    await service.handleOrderCreated(
      payload("user-5", [
        { bookId: "", amount: 1 },
        { bookId: "b1", amount: 0 },
        { bookId: "b1", amount: 1.5 }
      ] as OrderCreatedPayload["goods"])
    );
    expect(repository.calls).toHaveLength(0);
    expect(repository.carts.get(userCartKey("user-5"))?.items).toEqual([
      { bookId: "b1", amount: 1 }
    ]);
  });

  it("never touches guest carts", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: 1 }]
    });
    await service.handleOrderCreated(payload("user-1", [good("b1", 1)]));
    expect(repository.carts.get(guestCartKey(GUEST_ID))?.items).toEqual([
      { bookId: "b1", amount: 1 }
    ]);
  });

  it("ignores a non-string/missing userId", async () => {
    const { service, repository } = harness();
    await service.handleOrderCreated({
      orderId: "o-1",
      userId: 42 as unknown as string,
      goods: [good("b1", 1)],
      totalPrice: 0
    });
    await service.handleOrderCreated(null as unknown as OrderCreatedPayload);
    expect(repository.calls).toHaveLength(0);
  });

  it("is idempotent — a redelivery of the same orderId does not decrement again", async () => {
    const { service, repository } = harness();
    repository.carts.set(userCartKey("user-5"), {
      items: [{ bookId: "b1", amount: 3 }]
    });
    const event = payload("user-5", [good("b1", 2)]);
    // Kafka is at-least-once: a crash between decrement and offset commit
    // (or a plain redelivery) must not eat the remaining units.
    await service.handleOrderCreated(event);
    await service.handleOrderCreated(event);
    expect(repository.carts.get(userCartKey("user-5"))?.items).toEqual([
      { bookId: "b1", amount: 1 }
    ]);
  });

  it("different orderIds decrement independently", async () => {
    const { service, repository } = harness();
    repository.carts.set(userCartKey("user-5"), {
      items: [{ bookId: "b1", amount: 5 }]
    });
    await service.handleOrderCreated({
      ...payload("user-5", [good("b1", 2)]),
      orderId: "order-a"
    });
    await service.handleOrderCreated({
      ...payload("user-5", [good("b1", 2)]),
      orderId: "order-b"
    });
    expect(repository.carts.get(userCartKey("user-5"))?.items).toEqual([
      { bookId: "b1", amount: 1 }
    ]);
  });

  it("ignores a missing/empty orderId — there is nothing to dedup on", async () => {
    const { service, repository } = harness();
    repository.carts.set(userCartKey("user-5"), {
      items: [{ bookId: "b1", amount: 3 }]
    });
    await service.handleOrderCreated({
      orderId: undefined as unknown as string,
      userId: "user-5",
      goods: [good("b1", 1)],
      totalPrice: 0
    });
    await service.handleOrderCreated({
      orderId: "",
      userId: "user-5",
      goods: [good("b1", 1)],
      totalPrice: 0
    });
    // without an orderId the event can never be deduplicated, so it is
    // treated as malformed — the cart is left untouched
    expect(repository.calls).toHaveLength(0);
    expect(repository.carts.get(userCartKey("user-5"))?.items).toEqual([
      { bookId: "b1", amount: 3 }
    ]);
  });
});

describe("RedisCartRepository (fake RedisLike)", () => {
  /** Recording stand-in asserting the exact commands the repo issues. */
  class FakeRedis implements RedisLike {
    values = new Map<string, string>();
    setCalls: { key: string; value: string; mode: string; seconds: number }[] =
      [];
    pipelineOps: string[] = [];
    evalCalls: string[] = [];

    async get(key: string): Promise<string | null> {
      return this.values.get(key) ?? null;
    }

    async set(
      key: string,
      value: string,
      expiryMode: "EX",
      seconds: number
    ): Promise<unknown> {
      this.setCalls.push({ key, value, mode: expiryMode, seconds });
      this.values.set(key, value);
      return "OK";
    }

    async del(...keys: string[]): Promise<unknown> {
      for (const key of keys) {
        this.values.delete(key);
      }
      return keys.length;
    }

    async expire(): Promise<unknown> {
      return 1;
    }

    /**
     * Test double for the decrement Lua script — re-implements its
     * semantics in JS (claim the orderId marker via SET … NX first —
     * a repeat exits early; missing/corrupt → 0; otherwise decrement
     * pairs, remove <= 0, rewrite with SET … EX).
     */
    async eval(
      script: string,
      numKeys: number,
      ...args: (string | number)[]
    ): Promise<unknown> {
      // eval(script, 1, key, markerKey, ttlSec, bookId, amount, …)
      const key = args[0] as string;
      this.evalCalls.push(key);
      // SET markerKey 1 NX EX ttl — the dedup guard: a redelivered
      // orderId returns before positions are touched again.
      const markerKey = args[1] as string;
      if (this.values.has(markerKey)) {
        return 0;
      }
      this.values.set(markerKey, "1");
      const raw = this.values.get(key);
      if (!raw) {
        return 0;
      }
      let cart: CartData;
      try {
        cart = JSON.parse(raw) as CartData;
      } catch {
        return 0;
      }
      if (!Array.isArray(cart?.items)) {
        return 0;
      }
      const ttlSec = args[2] as number;
      for (let i = 3; i + 1 < args.length; i += 2) {
        const bookId = args[i] as string;
        const amount = args[i + 1] as number;
        const index = cart.items.findIndex((item) => item.bookId === bookId);
        if (index < 0) {
          continue;
        }
        const remaining = cart.items[index].amount - amount;
        if (remaining <= 0) {
          cart.items.splice(index, 1);
        } else {
          cart.items[index].amount = remaining;
        }
      }
      const value = JSON.stringify(cart);
      this.setCalls.push({ key, value, mode: "EX", seconds: ttlSec });
      this.values.set(key, value);
      return 1;
    }

    multi(): RedisPipeline {
      const ops: string[] = [];
      const apply: (() => void)[] = [];
      const pipelineOps = this.pipelineOps;
      const values = this.values;
      const pipeline: RedisPipeline = {
        set(key, value, expiryMode, seconds) {
          ops.push(`SET ${key} ${value} ${expiryMode} ${seconds}`);
          apply.push(() => values.set(key, value));
          return pipeline;
        },
        del(...keys) {
          ops.push(`DEL ${keys.join(" ")}`);
          apply.push(() => keys.forEach((key) => values.delete(key)));
          return pipeline;
        },
        async exec() {
          pipelineOps.push(...ops);
          // MULTI/EXEC is atomic — buffered commands apply together.
          apply.forEach((op) => op());
          return ops.map(() => [null, "OK"]);
        }
      };
      return pipeline;
    }
  }

  it("writes the cart with SET … EX ttl in a single command", async () => {
    const redis = new FakeRedis();
    const repo = new RedisCartRepository(redis);
    await repo.set(
      "cart:guest:x",
      { items: [{ bookId: "b1", amount: 1 }] },
      60
    );
    expect(redis.setCalls).toEqual([
      {
        key: "cart:guest:x",
        value: JSON.stringify({ items: [{ bookId: "b1", amount: 1 }] }),
        mode: "EX",
        seconds: 60
      }
    ]);
    // no separate EXPIRE step — the write itself is the TTL
    expect(redis.pipelineOps).toEqual([]);
  });

  it("setAndDelete wraps SET … EX + DEL in one MULTI/EXEC", async () => {
    const redis = new FakeRedis();
    const repo = new RedisCartRepository(redis);
    await repo.setAndDelete("cart:user:u1", { items: [] }, 60, "cart:guest:g1");
    expect(redis.pipelineOps).toEqual([
      `SET cart:user:u1 ${JSON.stringify({ items: [] })} EX 60`,
      "DEL cart:guest:g1"
    ]);
    expect(redis.setCalls).toEqual([]);
  });

  it("corrupt stored JSON reads as a missing cart (no UNKNOWN leak)", async () => {
    const redis = new FakeRedis();
    redis.values.set("cart:guest:x", "not-json{{{");
    const repo = new RedisCartRepository(redis);
    expect(await repo.get("cart:guest:x")).toBeNull();
  });

  it("lookup distinguishes missing / corrupt / ok", async () => {
    const redis = new FakeRedis();
    redis.values.set("cart:guest:corrupt", "not-json{{{");
    redis.values.set(
      "cart:guest:ok",
      JSON.stringify({ items: [{ bookId: "b1", amount: 2 }] })
    );
    const repo = new RedisCartRepository(redis);
    expect(await repo.lookup("cart:guest:absent")).toEqual({
      status: "missing"
    });
    expect(await repo.lookup("cart:guest:corrupt")).toEqual({
      status: "corrupt"
    });
    expect(await repo.lookup("cart:guest:ok")).toEqual({
      status: "ok",
      cart: { items: [{ bookId: "b1", amount: 2 }] }
    });
  });

  it("decrementItems rewrites the cart via eval with SET … EX (F-K4)", async () => {
    const redis = new FakeRedis();
    redis.values.set(
      "cart:user:u1",
      JSON.stringify({
        items: [
          { bookId: "b1", amount: 2 },
          { bookId: "b2", amount: 5 }
        ]
      })
    );
    const repo = new RedisCartRepository(redis);
    await repo.decrementItems(
      "cart:user:u1",
      [
        { bookId: "b1", amount: 2 },
        { bookId: "b2", amount: 1 }
      ],
      60,
      "order-1"
    );
    expect(redis.evalCalls).toEqual(["cart:user:u1"]);
    expect(JSON.parse(redis.values.get("cart:user:u1")!)).toEqual({
      items: [{ bookId: "b2", amount: 4 }]
    });
    // the rewrite carried the sliding TTL in the same command, and the
    // orderId marker was claimed for dedup
    expect(redis.setCalls.at(-1)).toMatchObject({ mode: "EX", seconds: 60 });
    expect(redis.values.get("cart:order-processed:order-1")).toBe("1");
  });

  it("decrementItems no-ops on a repeated orderId — at-least-once dedup", async () => {
    const redis = new FakeRedis();
    redis.values.set(
      "cart:user:u1",
      JSON.stringify({ items: [{ bookId: "b1", amount: 3 }] })
    );
    const repo = new RedisCartRepository(redis);
    const goods = [{ bookId: "b1", amount: 2 }];
    await repo.decrementItems("cart:user:u1", goods, 60, "order-1");
    await repo.decrementItems("cart:user:u1", goods, 60, "order-1");
    // the second delivery found the marker and exited before decrementing
    expect(JSON.parse(redis.values.get("cart:user:u1")!)).toEqual({
      items: [{ bookId: "b1", amount: 1 }]
    });
    // a different orderId is not deduplicated
    await repo.decrementItems("cart:user:u1", goods, 60, "order-2");
    expect(JSON.parse(redis.values.get("cart:user:u1")!)).toEqual({
      items: []
    });
    expect(redis.values.get("cart:order-processed:order-2")).toBe("1");
  });

  it("decrementItems no-ops on missing/corrupt keys and empty goods", async () => {
    const redis = new FakeRedis();
    redis.values.set("cart:user:corrupt", "not-json{{{");
    const repo = new RedisCartRepository(redis);
    await repo.decrementItems(
      "cart:user:absent",
      [{ bookId: "b", amount: 1 }],
      60,
      "order-a"
    );
    await repo.decrementItems(
      "cart:user:corrupt",
      [{ bookId: "b", amount: 1 }],
      60,
      "order-b"
    );
    await repo.decrementItems("cart:user:anything", [], 60, "order-c");
    expect(redis.values.has("cart:user:absent")).toBe(false);
    expect(redis.values.get("cart:user:corrupt")).toBe("not-json{{{");
    // empty goods short-circuits before eval — no marker claimed either
    expect(redis.evalCalls).toEqual(["cart:user:absent", "cart:user:corrupt"]);
    expect(redis.values.has("cart:order-processed:order-c")).toBe(false);
    expect(redis.setCalls).toEqual([]);
  });

  it("mergeCart over the Redis repo deletes an existing corrupt guest key", async () => {
    const redis = new FakeRedis();
    redis.values.set(guestCartKey(GUEST_ID), "not-json{{{");
    redis.values.set(
      userCartKey("user-1"),
      JSON.stringify({ items: [{ bookId: "b1", amount: 1 }] })
    );
    const service = new CartService({
      repository: new RedisCartRepository(redis),
      cartTtlSec: TTL
    });

    const cart = await service.mergeCart(
      { guestCartId: GUEST_ID },
      caller("user-1")
    );
    expect(cart.items).toEqual([{ bookId: "b1", amount: 1 }]);
    // the MULTI carried SET user-key + DEL guest-key — the corrupt key is
    // gone from storage, not just unreadable.
    expect(redis.pipelineOps).toContain(`DEL ${guestCartKey(GUEST_ID)}`);
    expect(redis.values.has(guestCartKey(GUEST_ID))).toBe(false);
  });

  it("parses a well-formed stored document", async () => {
    const redis = new FakeRedis();
    redis.values.set(
      "cart:guest:x",
      JSON.stringify({ items: [{ bookId: "b1", amount: 2 }] })
    );
    const repo = new RedisCartRepository(redis);
    expect(await repo.get("cart:guest:x")).toEqual({
      items: [{ bookId: "b1", amount: 2 }]
    });
  });
});
