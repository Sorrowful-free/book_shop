import { describe, expect, it } from "bun:test";
import { status } from "@grpc/grpc-js";
import type { UserContext } from "@book-shop/common";
import { UserRole } from "@book-shop/contracts";
import { CartService } from "./cart.service";
import type { CartData, CartRepository } from "./repository";
import { guestCartKey, userCartKey } from "./repository";

const TTL = 3600;
const GUEST_ID = "3f6a1d2e-9b8c-4e5a-a7b6-c5d4e3f2a1b0";
const OTHER_GUEST_ID = "8d2c1b0a-4f5e-4d6c-9b8a-7c6d5e4f3a2b";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RepoCall {
  method: "get" | "set" | "delete" | "expire";
  key: string;
}

class InMemoryCartRepository implements CartRepository {
  carts = new Map<string, CartData>();
  calls: RepoCall[] = [];
  expirations: { key: string; ttlSec: number }[] = [];

  async get(key: string): Promise<CartData | null> {
    this.calls.push({ method: "get", key });
    const cart = this.carts.get(key);
    return cart ? { items: cart.items.map((item) => ({ ...item })) } : null;
  }

  async set(key: string, cart: CartData): Promise<void> {
    this.calls.push({ method: "set", key });
    this.carts.set(key, { items: cart.items.map((item) => ({ ...item })) });
  }

  async delete(key: string): Promise<void> {
    this.calls.push({ method: "delete", key });
    this.carts.delete(key);
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

describe("CartService.handleOrderCreated (order.order.created → ClearCart)", () => {
  const payload = (userId: string) => ({
    orderId: "order-1",
    userId,
    goods: [],
    totalPrice: 0
  });

  it("deletes the user cart for payload.userId", async () => {
    const { service, repository } = harness();
    repository.carts.set(userCartKey("user-5"), {
      items: [{ bookId: "b1", amount: 1 }]
    });
    await service.handleOrderCreated(payload("user-5"));
    expect(repository.carts.has(userCartKey("user-5"))).toBe(false);
  });

  it("is a no-op success when the user cart is absent", async () => {
    const { service } = harness();
    await service.handleOrderCreated(payload("no-such-user"));
  });

  it("never touches guest carts", async () => {
    const { service, repository } = harness();
    repository.carts.set(guestCartKey(GUEST_ID), {
      items: [{ bookId: "b1", amount: 1 }]
    });
    await service.handleOrderCreated(payload("user-1"));
    expect(repository.carts.has(guestCartKey(GUEST_ID))).toBe(true);
  });
});
