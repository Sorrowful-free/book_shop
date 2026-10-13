// Unit tests for GetOrder / ListMyOrders / PayOrder / CancelOrder:
// status transitions, the ownership rule (sub == user_id or ADMIN/EMPLOYER),
// error mapping and the F-O1..F-O3 fix branches. Repository and dep clients
// are in-memory test doubles behind the production interfaces.

import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { Metadata, status } from "@grpc/grpc-js";
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
  seedCatalogBook,
  type InMemoryOrderRepository
} from "../test/helpers";
import type { OrderRecord } from "./repository";

const CUSTOMER = caller(UserRole.Customer, "user-1");
const ADMIN = caller(UserRole.Admin, "admin-1");
const EMPLOYER = caller(UserRole.Employer, "emp-1");

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
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
}

function seedOrder(
  repository: InMemoryOrderRepository,
  overrides: Partial<OrderRecord> = {}
): OrderRecord {
  const order = makeOrder(overrides);
  repository.orders.set(order.id, order);
  return order;
}

function outboxTypes(repository: InMemoryOrderRepository): string[] {
  return repository.outbox.map((entry) => entry.eventType);
}

// ---------------------------------------------------------------------------
// GetOrder
// ---------------------------------------------------------------------------

describe("GetOrder", () => {
  it("returns the caller's own order", async () => {
    const { service, repository } = harness();
    const order = seedOrder(repository);
    const result = await service.getOrder({ orderId: order.id }, CUSTOMER);
    expect(result.orderId).toBe(order.id);
    expect(result.status).toBe(1); // PENDING
  });

  it("ADMIN and EMPLOYER can read another user's order", async () => {
    const { service, repository } = harness();
    const order = seedOrder(repository);
    for (const staff of [ADMIN, EMPLOYER]) {
      const result = await service.getOrder({ orderId: order.id }, staff);
      expect(result.orderId).toBe(order.id);
    }
  });

  it("rejects another user's order for a CUSTOMER with PERMISSION_DENIED", async () => {
    const { service, repository } = harness();
    const order = seedOrder(repository, { userId: "someone-else" });
    await expectGrpcError(
      service.getOrder({ orderId: order.id }, CUSTOMER),
      status.PERMISSION_DENIED
    );
  });

  it("answers NOT_FOUND for a missing order, UNAUTHENTICATED without a token", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.getOrder({ orderId: randomUUID() }, CUSTOMER),
      status.NOT_FOUND
    );
    await expectGrpcError(
      service.getOrder({ orderId: randomUUID() }, null),
      status.UNAUTHENTICATED
    );
    await expectGrpcError(
      service.getOrder({ orderId: "not-a-uuid" }, CUSTOMER),
      status.INVALID_ARGUMENT
    );
  });
});

// ---------------------------------------------------------------------------
// ListMyOrders
// ---------------------------------------------------------------------------

describe("ListMyOrders", () => {
  it("returns only the caller's orders, newest first, with pagination", async () => {
    const { service, repository } = harness();
    const older = seedOrder(repository, {
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    const newer = seedOrder(repository, {
      createdAt: new Date("2026-02-01T00:00:00Z")
    });
    seedOrder(repository, {
      userId: "someone-else",
      createdAt: new Date("2026-03-01T00:00:00Z")
    });

    const first = await service.listMyOrders(
      { offset: 0, limit: 10 },
      CUSTOMER
    );
    // F-O5: created_at DESC — the newer order leads.
    expect(first.orders.map((order) => order.orderId)).toEqual([
      newer.id,
      older.id
    ]);
    expect(first.total).toBe(2);

    const paged = await service.listMyOrders({ offset: 1, limit: 1 }, CUSTOMER);
    expect(paged.orders.map((order) => order.orderId)).toEqual([older.id]);
    expect(paged.total).toBe(2);
  });

  it("normalizes an absent offset to 0 and validates the page bounds", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.listMyOrders({ offset: 0, limit: 0 }, CUSTOMER),
      status.INVALID_ARGUMENT
    );
    await expectGrpcError(
      service.listMyOrders({ offset: 0, limit: 101 }, CUSTOMER),
      status.INVALID_ARGUMENT
    );
    await expectGrpcError(
      service.listMyOrders({ offset: -1, limit: 10 }, CUSTOMER),
      status.INVALID_ARGUMENT
    );
    await expectGrpcError(
      service.listMyOrders({ offset: 0, limit: 10 }, null),
      status.UNAUTHENTICATED
    );
  });
});

// ---------------------------------------------------------------------------
// PayOrder
// ---------------------------------------------------------------------------

describe("PayOrder", () => {
  it("commits the reservation, marks the order PAID and emits order.paid", async () => {
    const now = new Date("2026-06-01T12:00:00Z");
    const { service, repository, catalog } = harness({ now: () => now });
    const order = seedOrder(repository);

    const paid = await service.payOrder(
      { orderId: order.id },
      CUSTOMER,
      callMetadata()
    );

    expect(paid.status).toBe(2); // PAID
    expect(paid.paidAt?.seconds).toBe(Math.floor(now.getTime() / 1000));
    expect(catalog.callsOf("commitStock")).toHaveLength(1);
    expect(catalog.callsOf("commitStock")[0]?.arg).toBe(order.reservationId);
    expect(outboxTypes(repository)).toEqual([EVENT_TYPES.orderPaid]);
  });

  it("is idempotent on an already-PAID order (F-O3)", async () => {
    const { service, repository, catalog } = harness();
    const order = seedOrder(repository, {
      status: "PAID",
      paidAt: new Date()
    });

    const result = await service.payOrder(
      { orderId: order.id },
      CUSTOMER,
      callMetadata()
    );

    expect(result.status).toBe(2);
    // No second CommitStock, no second order.paid (F-O3).
    expect(catalog.calls).toHaveLength(0);
    expect(repository.outbox).toHaveLength(0);
  });

  it("rejects a CANCELLED order with FAILED_PRECONDITION", async () => {
    const { service, repository, catalog } = harness();
    const order = seedOrder(repository, { status: "CANCELLED" });
    await expectGrpcError(
      service.payOrder({ orderId: order.id }, CUSTOMER, callMetadata()),
      status.FAILED_PRECONDITION
    );
    expect(catalog.calls).toHaveLength(0);
  });

  it("cancels the order and answers FAILED_PRECONDITION when the reservation expired", async () => {
    const { service, repository, catalog } = harness();
    const order = seedOrder(repository);
    catalog.commitError = grpcFailure(
      status.NOT_FOUND,
      "reservation not found or expired"
    );

    const error = await catchGrpcError(
      service.payOrder({ orderId: order.id }, CUSTOMER, callMetadata())
    );
    // Caller sees FAILED_PRECONDITION (spec §2) even though catalog said
    // NOT_FOUND — the order's own state transition is the answer.
    expect(grpcCode(error)).toBe(status.FAILED_PRECONDITION);
    const stored = repository.orders.get(order.id)!;
    expect(stored.status).toBe("CANCELLED");
    expect(stored.cancelledAt).not.toBeNull();
    expect(outboxTypes(repository)).toEqual([EVENT_TYPES.orderCancelled]);
  });

  it("F-O1: CommitStock FAILED_PRECONDITION → best-effort release + CANCELLED + order.cancelled + FP", async () => {
    const { service, repository, catalog } = harness();
    const order = seedOrder(repository);
    catalog.commitError = grpcFailure(
      status.FAILED_PRECONDITION,
      "stock no longer covers the reserved amount"
    );

    const error = await catchGrpcError(
      service.payOrder({ orderId: order.id }, CUSTOMER, callMetadata())
    );
    expect(grpcCode(error)).toBe(status.FAILED_PRECONDITION);
    // Best-effort release ran once on the still-ACTIVE reservation.
    expect(catalog.callsOf("releaseStock")).toHaveLength(1);
    expect(catalog.callsOf("releaseStock")[0]?.arg).toBe(order.reservationId);
    expect(repository.orders.get(order.id)!.status).toBe("CANCELLED");
    expect(outboxTypes(repository)).toEqual([EVENT_TYPES.orderCancelled]);
  });

  it("F-O1: an expired reservation at release time does not change the outcome", async () => {
    const { service, repository, catalog } = harness();
    const order = seedOrder(repository);
    catalog.commitError = grpcFailure(status.FAILED_PRECONDITION, "no stock");
    // The reservation expired between commit and the best-effort release —
    // the release error is ignored, the order still cancels.
    catalog.releaseError = grpcFailure(status.NOT_FOUND, "expired");

    await expectGrpcError(
      service.payOrder({ orderId: order.id }, CUSTOMER, callMetadata()),
      status.FAILED_PRECONDITION
    );
    expect(repository.orders.get(order.id)!.status).toBe("CANCELLED");
    expect(outboxTypes(repository)).toEqual([EVENT_TYPES.orderCancelled]);
  });

  it("maps a dead catalog to UNAVAILABLE and leaves the order PENDING", async () => {
    const { service, repository, catalog } = harness();
    const order = seedOrder(repository);
    catalog.commitError = grpcFailure(status.UNAVAILABLE, "connection refused");

    await expectGrpcError(
      service.payOrder({ orderId: order.id }, CUSTOMER, callMetadata()),
      status.UNAVAILABLE
    );
    expect(repository.orders.get(order.id)!.status).toBe("PENDING");
    expect(repository.outbox).toHaveLength(0);
  });

  it("enforces ownership: PERMISSION_DENIED for strangers, NOT_FOUND for missing", async () => {
    const { service, repository } = harness();
    const order = seedOrder(repository);
    await expectGrpcError(
      service.payOrder(
        { orderId: order.id },
        caller(UserRole.Customer, "stranger"),
        callMetadata()
      ),
      status.PERMISSION_DENIED
    );
    await expectGrpcError(
      service.payOrder({ orderId: randomUUID() }, CUSTOMER, callMetadata()),
      status.NOT_FOUND
    );
    await expectGrpcError(
      service.payOrder({ orderId: order.id }, null, new Metadata()),
      status.UNAUTHENTICATED
    );
    // ADMIN may pay someone else's order.
    const other = seedOrder(repository, { userId: "owner-x" });
    const paid = await service.payOrder(
      { orderId: other.id },
      ADMIN,
      callMetadata()
    );
    expect(paid.status).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CancelOrder
// ---------------------------------------------------------------------------

describe("CancelOrder", () => {
  it("releases the reservation, marks the order CANCELLED and emits order.cancelled", async () => {
    const now = new Date("2026-06-01T12:00:00Z");
    const { service, repository, catalog } = harness({ now: () => now });
    const order = seedOrder(repository);

    const cancelled = await service.cancelOrder(
      { orderId: order.id },
      CUSTOMER,
      callMetadata()
    );

    expect(cancelled.status).toBe(3); // CANCELLED
    expect(cancelled.cancelledAt?.seconds).toBe(
      Math.floor(now.getTime() / 1000)
    );
    expect(catalog.callsOf("releaseStock")).toHaveLength(1);
    expect(catalog.callsOf("releaseStock")[0]?.arg).toBe(order.reservationId);
    expect(outboxTypes(repository)).toEqual([EVENT_TYPES.orderCancelled]);
  });

  it("an already-gone reservation (NOT_FOUND) still cancels the order", async () => {
    const { service, repository, catalog } = harness();
    const order = seedOrder(repository);
    catalog.releaseError = grpcFailure(status.NOT_FOUND, "expired");

    const cancelled = await service.cancelOrder(
      { orderId: order.id },
      CUSTOMER,
      callMetadata()
    );
    expect(cancelled.status).toBe(3);
    expect(outboxTypes(repository)).toEqual([EVENT_TYPES.orderCancelled]);
  });

  it("F-O2: a COMMITTED reservation self-heals the order to PAID + order.paid", async () => {
    const { service, repository, catalog } = harness();
    const order = seedOrder(repository);
    catalog.releaseError = grpcFailure(
      status.FAILED_PRECONDITION,
      "reservation cannot be released",
      { reservationStatus: "COMMITTED" }
    );

    const healed = await service.cancelOrder(
      { orderId: order.id },
      CUSTOMER,
      callMetadata()
    );

    expect(healed.status).toBe(2); // PAID
    expect(healed.paidAt).toBeTruthy();
    expect(outboxTypes(repository)).toEqual([EVENT_TYPES.orderPaid]);
  });

  it("F-O2: a RELEASED reservation cancels the order", async () => {
    const { service, repository, catalog } = harness();
    const order = seedOrder(repository);
    catalog.releaseError = grpcFailure(
      status.FAILED_PRECONDITION,
      "reservation cannot be released",
      { reservationStatus: "RELEASED" }
    );

    const cancelled = await service.cancelOrder(
      { orderId: order.id },
      CUSTOMER,
      callMetadata()
    );
    expect(cancelled.status).toBe(3);
    expect(outboxTypes(repository)).toEqual([EVENT_TYPES.orderCancelled]);
  });

  it("F-O2: reservationStatus mentioned only in the message text is not trusted — CANCELLED", async () => {
    const { service, repository, catalog } = harness();
    const order = seedOrder(repository);
    // A peer that flattens the status into the message is
    // indistinguishable from a stray mention — only structured details
    // count, so this must NOT self-heal to PAID.
    catalog.releaseError = grpcFailure(
      status.FAILED_PRECONDITION,
      'reservation cannot be released: {"reservationStatus":"COMMITTED"}'
    );

    const cancelled = await service.cancelOrder(
      { orderId: order.id },
      CUSTOMER,
      callMetadata()
    );
    expect(cancelled.status).toBe(3);
    expect(outboxTypes(repository)).toEqual([EVENT_TYPES.orderCancelled]);
  });

  it("F-O2: FAILED_PRECONDITION without details falls back to CANCELLED (old catalog)", async () => {
    const { service, repository, catalog } = harness();
    const order = seedOrder(repository);
    catalog.releaseError = grpcFailure(
      status.FAILED_PRECONDITION,
      "reservation cannot be released"
    );

    const cancelled = await service.cancelOrder(
      { orderId: order.id },
      CUSTOMER,
      callMetadata()
    );
    expect(cancelled.status).toBe(3);
    expect(outboxTypes(repository)).toEqual([EVENT_TYPES.orderCancelled]);
  });

  it("rejects PAID and CANCELLED orders with FAILED_PRECONDITION", async () => {
    const { service, repository, catalog } = harness();
    const paidOrder = seedOrder(repository, { status: "PAID" });
    const cancelledOrder = seedOrder(repository, { status: "CANCELLED" });
    await expectGrpcError(
      service.cancelOrder({ orderId: paidOrder.id }, CUSTOMER, callMetadata()),
      status.FAILED_PRECONDITION
    );
    await expectGrpcError(
      service.cancelOrder(
        { orderId: cancelledOrder.id },
        CUSTOMER,
        callMetadata()
      ),
      status.FAILED_PRECONDITION
    );
    expect(catalog.calls).toHaveLength(0);
  });

  it("maps a dead catalog to UNAVAILABLE and leaves the order PENDING", async () => {
    const { service, repository, catalog } = harness();
    const order = seedOrder(repository);
    catalog.releaseError = grpcFailure(status.DEADLINE_EXCEEDED, "deadline");

    await expectGrpcError(
      service.cancelOrder({ orderId: order.id }, CUSTOMER, callMetadata()),
      status.UNAVAILABLE
    );
    expect(repository.orders.get(order.id)!.status).toBe("PENDING");
  });

  it("enforces ownership and UNAUTHENTICATED", async () => {
    const { service, repository } = harness();
    const order = seedOrder(repository);
    await expectGrpcError(
      service.cancelOrder(
        { orderId: order.id },
        caller(UserRole.Customer, "stranger"),
        callMetadata()
      ),
      status.PERMISSION_DENIED
    );
    await expectGrpcError(
      service.cancelOrder({ orderId: order.id }, null, new Metadata()),
      status.UNAUTHENTICATED
    );
    // EMPLOYER may cancel someone's order.
    const cancelled = await service.cancelOrder(
      { orderId: order.id },
      EMPLOYER,
      callMetadata()
    );
    expect(cancelled.status).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Details pass-through (F-O4) — the RpcException payload keeps the
// structured details the dependency sent.
// ---------------------------------------------------------------------------

describe("dependency error details", () => {
  it("preserves details from an RpcException-shaped dep error", async () => {
    const { service, cart, catalog } = harness();
    seedCatalogBook(catalog, { bookId: "b-1" });
    cart.cart = { items: [{ bookId: "b-1", amount: 1 }] };
    // The RpcException shape produced by the repo's rpcError convention —
    // details inside the payload object, code on top.
    catalog.getBooksError = Object.assign(new Error("books not found: b-9"), {
      code: status.NOT_FOUND,
      error: {
        code: status.NOT_FOUND,
        message: "books not found: b-9",
        details: { missingBookIds: ["b-9"] }
      }
    });

    const error = await catchGrpcError(
      service.checkout(
        { idempotencyKey: randomUUID() },
        CUSTOMER,
        callMetadata()
      )
    );
    expect(grpcCode(error)).toBe(status.NOT_FOUND);
    expect(errorDetails(error)?.missingBookIds).toEqual(["b-9"]);
  });
});
