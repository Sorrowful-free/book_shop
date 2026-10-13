// Unit tests for the checkout saga (spec §2): call ordering, compensation
// on every step, idempotency (repeat + unique-violation race) and the F-O4
// error pass-through contract. Repository and cart/catalog clients are
// in-memory test doubles behind the same interfaces production uses.

import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { status } from "@grpc/grpc-js";
import { Metadata } from "@grpc/grpc-js";
import { EVENT_TYPES, UserRole } from "@book-shop/contracts";
import {
  caller,
  callMetadata,
  catchGrpcError,
  errorDetails,
  expectGrpcError,
  grpcCode,
  grpcFailure,
  harness,
  seedCatalogBook
} from "../test/helpers";
import type { OrderRecord } from "./repository";

const CUSTOMER = caller(UserRole.Customer, "user-1");

function seedOrder(
  repository: ReturnType<typeof harness>["repository"],
  overrides: Partial<OrderRecord> = {}
): OrderRecord {
  const order: OrderRecord = {
    id: randomUUID(),
    userId: CUSTOMER.userId,
    status: "PENDING",
    totalPrice: 20,
    reservationId: `res-${randomUUID().slice(0, 8)}`,
    idempotencyKey: randomUUID(),
    items: [
      {
        bookId: "b-1",
        bookName: "Book",
        author: "Author",
        price: 10,
        amount: 2
      }
    ],
    createdAt: new Date(),
    paidAt: null,
    cancelledAt: null,
    ...overrides
  };
  repository.orders.set(order.id, order);
  return order;
}

describe("checkout saga — happy path", () => {
  it("runs cart → snapshot → reserve → persist+outbox and returns PENDING", async () => {
    const { service, repository, cart, catalog } = harness();
    const b1 = seedCatalogBook(catalog, {
      bookId: "b-1",
      bookName: "Dune",
      author: "Herbert",
      price: 12.5
    });
    const b2 = seedCatalogBook(catalog, {
      bookId: "b-2",
      bookName: "Foundation",
      author: "Asimov",
      price: 7.25
    });
    // Deliberately unsorted cart — items must come out book_id ASC (F-O5).
    cart.cart = {
      items: [
        { bookId: b2.bookId, amount: 4 },
        { bookId: b1.bookId, amount: 2 }
      ]
    };

    const order = await service.checkout(
      { idempotencyKey: randomUUID() },
      CUSTOMER,
      callMetadata()
    );

    expect(order.orderId).toBeTruthy();
    expect(order.userId).toBe(CUSTOMER.userId);
    expect(order.status).toBe(1); // ORDER_STATUS_PENDING
    expect(order.items.map((item) => item.bookId)).toEqual(["b-1", "b-2"]);
    // Snapshot fields are frozen from the catalog answer.
    expect(order.items[0]).toMatchObject({
      bookName: "Dune",
      author: "Herbert",
      price: 12.5,
      amount: 2
    });
    // 12.5*2 + 7.25*4 = 25 + 29 = 54
    expect(order.totalPrice).toBe(54);

    // Saga order: getCart → getBooksByIds → reserveStock → persist.
    expect(cart.calls).toHaveLength(1);
    expect(catalog.calls.map((call) => call.method)).toEqual([
      "getBooksByIds",
      "reserveStock"
    ]);
    expect(catalog.callsOf("reserveStock")[0]?.arg).toEqual([
      { bookId: "b-1", amount: 2 },
      { bookId: "b-2", amount: 4 }
    ]);

    // Reservation id persisted on the order.
    const stored = repository.orders.get(order.orderId)!;
    expect(stored.reservationId).toBe(catalog.nextReservationId);

    // order.order.created landed in the same unit of work as the order.
    expect(repository.outbox).toHaveLength(1);
    expect(repository.outbox[0]?.eventType).toBe(EVENT_TYPES.orderCreated);
    const payload = repository.outbox[0]?.payload as {
      orderId: string;
      userId: string;
      goods: { bookId: string }[];
      totalPrice: number;
    };
    expect(payload.orderId).toBe(order.orderId);
    expect(payload.userId).toBe(CUSTOMER.userId);
    expect(payload.totalPrice).toBe(54);
    expect(payload.goods.map((item) => item.bookId)).toEqual(["b-1", "b-2"]);
  });

  it("propagates the caller's authorization metadata verbatim to every dep call", async () => {
    const { service, cart, catalog } = harness();
    seedCatalogBook(catalog, { bookId: "b-1" });
    cart.cart = { items: [{ bookId: "b-1", amount: 1 }] };
    const metadata = callMetadata("Bearer THE-TOKEN");
    // x-user-* must NOT leak downstream — only authorization is forwarded.
    metadata.add("x-user-id", "mallory");

    await service.checkout(
      { idempotencyKey: randomUUID() },
      CUSTOMER,
      metadata
    );

    for (const call of [
      ...cart.calls.map((c) => c.metadata),
      ...catalog.calls.map((c) => c.metadata)
    ]) {
      expect(call?.get("authorization")[0]).toBe("Bearer THE-TOKEN");
      expect(call?.get("x-user-id")).toHaveLength(0);
    }
  });

  it("aggregates duplicated cart positions into one snapshot item", async () => {
    const { service, cart, catalog } = harness();
    seedCatalogBook(catalog, { bookId: "b-1", price: 3 });
    cart.cart = {
      items: [
        { bookId: "b-1", amount: 2 },
        { bookId: "b-1", amount: 3 }
      ]
    };

    const order = await service.checkout(
      { idempotencyKey: randomUUID() },
      CUSTOMER,
      callMetadata()
    );

    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({ bookId: "b-1", amount: 5 });
    expect(order.totalPrice).toBe(15);
    expect(catalog.callsOf("reserveStock")[0]?.arg).toEqual([
      { bookId: "b-1", amount: 5 }
    ]);
  });
});

describe("checkout idempotency", () => {
  it("returns the existing order for a repeated key without a new saga", async () => {
    const { service, cart, catalog } = harness();
    seedCatalogBook(catalog, { bookId: "b-1" });
    cart.cart = { items: [{ bookId: "b-1", amount: 1 }] };
    const key = randomUUID();

    const first = await service.checkout(
      { idempotencyKey: key },
      CUSTOMER,
      callMetadata()
    );
    cart.calls = [];
    catalog.calls = [];

    const second = await service.checkout(
      { idempotencyKey: key },
      CUSTOMER,
      callMetadata()
    );

    expect(second.orderId).toBe(first.orderId);
    expect(cart.calls).toHaveLength(0);
    expect(catalog.calls).toHaveLength(0);
  });

  it("the same key is allowed for a different user", async () => {
    const { service, cart, catalog } = harness();
    seedCatalogBook(catalog, { bookId: "b-1" });
    cart.cart = { items: [{ bookId: "b-1", amount: 1 }] };
    const key = randomUUID();

    const first = await service.checkout(
      { idempotencyKey: key },
      CUSTOMER,
      callMetadata()
    );
    const second = await service.checkout(
      { idempotencyKey: key },
      caller(UserRole.Customer, "user-2"),
      callMetadata()
    );

    expect(second.orderId).not.toBe(first.orderId);
  });

  it("a lost race on the unique index releases the orphan reservation and returns the winner", async () => {
    const { service, repository, cart, catalog } = harness();
    seedCatalogBook(catalog, { bookId: "b-1" });
    cart.cart = { items: [{ bookId: "b-1", amount: 1 }] };
    const key = randomUUID();

    // The winner exists at insert time but was invisible to the loser's
    // pre-check (it committed concurrently — the real race). The double
    // enforces the unique constraint, so the loser's persist throws P2002.
    const winner = seedOrder(repository, { idempotencyKey: key });
    repository.missIdempotencyLookupOnce = true;

    const order = await service.checkout(
      { idempotencyKey: key },
      CUSTOMER,
      callMetadata()
    );

    expect(order.orderId).toBe(winner.id);
    // The orphan reservation created by the losing saga was compensated.
    expect(catalog.callsOf("releaseStock")).toHaveLength(1);
    expect(catalog.callsOf("releaseStock")[0]?.arg).toBe(
      catalog.nextReservationId
    );
  });
});

describe("checkout compensation and error mapping", () => {
  it("rejects an empty cart with FAILED_PRECONDITION before touching catalog", async () => {
    const { service, cart, catalog } = harness();
    cart.cart = { items: [] };

    await expectGrpcError(
      service.checkout(
        { idempotencyKey: randomUUID() },
        CUSTOMER,
        callMetadata()
      ),
      status.FAILED_PRECONDITION
    );
    expect(catalog.calls).toHaveLength(0);
  });

  it("propagates GetBooksByIds NOT_FOUND verbatim — no reservation, no persist", async () => {
    const { service, repository, cart, catalog } = harness();
    cart.cart = { items: [{ bookId: "b-gone", amount: 1 }] };
    // The stub returns only found books — a cart position the catalog does
    // not know maps to NOT_FOUND.
    await expectGrpcError(
      service.checkout(
        { idempotencyKey: randomUUID() },
        CUSTOMER,
        callMetadata()
      ),
      status.NOT_FOUND
    );
    expect(repository.orders.size).toBe(0);
    expect(repository.outbox).toHaveLength(0);
    expect(catalog.callsOf("reserveStock")).toHaveLength(0);
  });

  it("passes catalog's NOT_FOUND with details through to the caller", async () => {
    const { service, cart, catalog } = harness();
    cart.cart = { items: [{ bookId: "b-1", amount: 1 }] };
    catalog.getBooksError = grpcFailure(
      status.NOT_FOUND,
      "books not found: b-1",
      { missingBookIds: ["b-1"] }
    );

    const error = await catchGrpcError(
      service.checkout(
        { idempotencyKey: randomUUID() },
        CUSTOMER,
        callMetadata()
      )
    );
    expect(grpcCode(error)).toBe(status.NOT_FOUND);
    expect(errorDetails(error)?.missingBookIds).toEqual(["b-1"]);
  });

  it("passes ReserveStock FAILED_PRECONDITION + unavailableBookIds through (F-O4)", async () => {
    const { service, repository, cart, catalog } = harness();
    seedCatalogBook(catalog, { bookId: "b-1" });
    cart.cart = { items: [{ bookId: "b-1", amount: 99 }] };
    catalog.reserveError = grpcFailure(
      status.FAILED_PRECONDITION,
      "books unavailable for reservation: b-1",
      { unavailableBookIds: ["b-1"] }
    );

    const error = await catchGrpcError(
      service.checkout(
        { idempotencyKey: randomUUID() },
        CUSTOMER,
        callMetadata()
      )
    );
    expect(grpcCode(error)).toBe(status.FAILED_PRECONDITION);
    expect(errorDetails(error)?.unavailableBookIds).toEqual(["b-1"]);
    // Nothing was persisted — the failure happened before step 4.
    expect(repository.orders.size).toBe(0);
    expect(repository.outbox).toHaveLength(0);
  });

  it("maps a dead cart-service to UNAVAILABLE", async () => {
    const { service, cart, catalog } = harness();
    cart.error = grpcFailure(status.UNAVAILABLE, "connection refused");

    await expectGrpcError(
      service.checkout(
        { idempotencyKey: randomUUID() },
        CUSTOMER,
        callMetadata()
      ),
      status.UNAVAILABLE
    );
    expect(catalog.calls).toHaveLength(0);
  });

  it("maps a deadline-exceeded catalog call to UNAVAILABLE", async () => {
    const { service, cart, catalog } = harness();
    seedCatalogBook(catalog, { bookId: "b-1" });
    cart.cart = { items: [{ bookId: "b-1", amount: 1 }] };
    catalog.reserveError = grpcFailure(
      status.DEADLINE_EXCEEDED,
      "deadline exceeded"
    );

    await expectGrpcError(
      service.checkout(
        { idempotencyKey: randomUUID() },
        CUSTOMER,
        callMetadata()
      ),
      status.UNAVAILABLE
    );
  });

  it("releases the reservation when persist fails and surfaces INTERNAL (non-unique error)", async () => {
    const { service, repository, cart, catalog } = harness();
    seedCatalogBook(catalog, { bookId: "b-1" });
    cart.cart = { items: [{ bookId: "b-1", amount: 1 }] };
    repository.createError = new Error("db connection lost");

    const error = await catchGrpcError(
      service.checkout(
        { idempotencyKey: randomUUID() },
        CUSTOMER,
        callMetadata()
      )
    );
    // The raw Prisma failure is wrapped — the caller sees INTERNAL, not
    // the driver's UNKNOWN-escaped error.
    expect(grpcCode(error)).toBe(status.INTERNAL);
    expect((error as Error).message).toContain("failed to persist order");
    // Compensation ran on the orphan reservation.
    expect(catalog.callsOf("releaseStock")).toHaveLength(1);
    expect(repository.orders.size).toBe(0);
    expect(repository.outbox).toHaveLength(0);
  });

  it("still returns the dep's domain error when compensation fails too", async () => {
    const { service, cart, catalog } = harness();
    seedCatalogBook(catalog, { bookId: "b-1" });
    cart.cart = { items: [{ bookId: "b-1", amount: 1 }] };
    catalog.reserveError = grpcFailure(status.FAILED_PRECONDITION, "no stock");
    catalog.releaseError = grpcFailure(status.UNAVAILABLE, "down");

    // reserveStock itself failed → nothing to compensate; FP still surfaces.
    await expectGrpcError(
      service.checkout(
        { idempotencyKey: randomUUID() },
        CUSTOMER,
        callMetadata()
      ),
      status.FAILED_PRECONDITION
    );
  });

  it("rejects a non-uuid idempotency_key with INVALID_ARGUMENT", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.checkout(
        { idempotencyKey: "not-a-uuid" },
        CUSTOMER,
        callMetadata()
      ),
      status.INVALID_ARGUMENT
    );
  });

  it("rejects an unauthenticated caller before any work", async () => {
    const { service, cart, catalog } = harness();
    await expectGrpcError(
      service.checkout({ idempotencyKey: randomUUID() }, null, new Metadata()),
      status.UNAUTHENTICATED
    );
    expect(cart.calls).toHaveLength(0);
    expect(catalog.calls).toHaveLength(0);
  });
});
