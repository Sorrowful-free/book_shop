// Shared unit-test kit: an in-memory OrderRepository test double, fake
// cart/catalog clients, the service harness and gRPC-error matchers. Lives
// in test/ (not src/) — these are test doubles, not implementations.

import { randomUUID } from "node:crypto";
import { expect } from "bun:test";
import { Metadata, status } from "@grpc/grpc-js";
import type { UserContext } from "@book-shop/common";
import { UserRole, cartProto, catalogProto } from "@book-shop/contracts";
import { OrderService } from "../src/order.service";
import type {
  NewOrder,
  OrderRecord,
  OrderRepository,
  OrderStatus,
  OutboxEventInput,
  PageRequest,
  TransitionResult
} from "../src/repository";
import {
  ERROR_DETAILS_METADATA_KEY,
  type CartClient,
  type CatalogClient
} from "../src/clients";

// ---------------------------------------------------------------------------
// In-memory OrderRepository test double
// ---------------------------------------------------------------------------

export class InMemoryOrderRepository implements OrderRepository {
  orders = new Map<string, OrderRecord>();
  outbox: OutboxEventInput[] = [];
  /** Forced failure for the next createOrderWithOutbox call. */
  createError?: unknown;
  /**
   * One-shot miss for findOrderByIdempotencyKey — simulates the checkout
   * race where the pre-check runs before the winning order commits while
   * the loser's own insert still hits the unique index.
   */
  missIdempotencyLookupOnce = false;

  private clone(order: OrderRecord): OrderRecord {
    return { ...order, items: order.items.map((item) => ({ ...item })) };
  }

  private sortedItems(order: NewOrder | OrderRecord) {
    return order.items
      .map((item) => ({ ...item }))
      .sort((a, b) => a.bookId.localeCompare(b.bookId));
  }

  async findOrderById(id: string): Promise<OrderRecord | null> {
    const order = this.orders.get(id);
    return order ? this.clone(order) : null;
  }

  async findOrderByIdempotencyKey(
    userId: string,
    idempotencyKey: string
  ): Promise<OrderRecord | null> {
    if (this.missIdempotencyLookupOnce) {
      this.missIdempotencyLookupOnce = false;
      return null;
    }
    const order = [...this.orders.values()].find(
      (candidate) =>
        candidate.userId === userId &&
        candidate.idempotencyKey === idempotencyKey
    );
    return order ? this.clone(order) : null;
  }

  async listOrdersByUser(
    userId: string,
    page: PageRequest
  ): Promise<{ orders: OrderRecord[]; total: number }> {
    const all = [...this.orders.values()]
      .filter((order) => order.userId === userId)
      // F-O5: created_at DESC, id DESC
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.id.localeCompare(a.id)
      );
    return {
      orders: all
        .slice(page.offset, page.offset + page.limit)
        .map((order) => this.clone(order)),
      total: all.length
    };
  }

  async createOrderWithOutbox(
    order: NewOrder,
    buildEvent: (created: OrderRecord) => OutboxEventInput
  ): Promise<OrderRecord> {
    if (this.createError !== undefined) {
      const error = this.createError;
      this.createError = undefined;
      throw error;
    }
    // The double enforces the same (user_id, idempotency_key) uniqueness the
    // @@unique index gives in Postgres — P2002 is what the real driver sends.
    const duplicate = [...this.orders.values()].some(
      (candidate) =>
        candidate.userId === order.userId &&
        candidate.idempotencyKey === order.idempotencyKey
    );
    if (duplicate) {
      throw Object.assign(
        new Error("Unique constraint failed on (user_id, idempotency_key)"),
        { code: "P2002" }
      );
    }
    const created: OrderRecord = {
      id: randomUUID(),
      userId: order.userId,
      status: "PENDING",
      totalPrice: order.totalPrice,
      reservationId: order.reservationId,
      idempotencyKey: order.idempotencyKey,
      items: this.sortedItems(order),
      createdAt: new Date(),
      paidAt: null,
      cancelledAt: null
    };
    // order + outbox row in ONE transaction — single repository call
    this.orders.set(created.id, created);
    this.outbox.push(buildEvent(this.clone(created)));
    return this.clone(created);
  }

  async transitionOrderWithOutbox(
    id: string,
    expected: OrderStatus,
    next: OrderStatus,
    now: Date,
    buildEvent: (order: OrderRecord) => OutboxEventInput
  ): Promise<TransitionResult | null> {
    const order = this.orders.get(id);
    if (!order) {
      return null;
    }
    if (order.status !== expected) {
      return { order: this.clone(order), transitioned: false };
    }
    order.status = next;
    if (next === "PAID") {
      order.paidAt = now;
    } else {
      order.cancelledAt = now;
    }
    const record = this.clone(order);
    this.outbox.push(buildEvent(record));
    return { order: record, transitioned: true };
  }
}

// ---------------------------------------------------------------------------
// Fake dependency clients — configurable results + full call log
// ---------------------------------------------------------------------------

export class FakeCartClient implements CartClient {
  cart: cartProto.Cart = { items: [] };
  error?: unknown;
  calls: { metadata?: Metadata }[] = [];

  async getCart(metadata: Metadata): Promise<cartProto.Cart> {
    this.calls.push({ metadata });
    if (this.error !== undefined) {
      throw this.error;
    }
    return this.cart;
  }
}

export class FakeCatalogClient implements CatalogClient {
  books = new Map<string, catalogProto.Book>();
  nextReservationId = `res-${randomUUID().slice(0, 8)}`;
  getBooksError?: unknown;
  reserveError?: unknown;
  commitError?: unknown;
  releaseError?: unknown;
  calls: {
    method: string;
    arg: unknown;
    metadata?: Metadata;
  }[] = [];

  async getBooksByIds(
    bookIds: string[],
    metadata: Metadata
  ): Promise<catalogProto.Book[]> {
    this.calls.push({ method: "getBooksByIds", arg: bookIds, metadata });
    if (this.getBooksError !== undefined) {
      throw this.getBooksError;
    }
    return bookIds
      .map((id) => this.books.get(id))
      .filter((book): book is catalogProto.Book => book !== undefined);
  }

  async reserveStock(
    items: catalogProto.StockReservationItem[],
    metadata: Metadata
  ): Promise<catalogProto.ReserveStockResponse> {
    this.calls.push({ method: "reserveStock", arg: items, metadata });
    if (this.reserveError !== undefined) {
      throw this.reserveError;
    }
    return {
      reservationId: this.nextReservationId,
      expiresAt: { seconds: 0, nanos: 0 }
    };
  }

  async commitStock(reservationId: string, metadata: Metadata): Promise<void> {
    this.calls.push({ method: "commitStock", arg: reservationId, metadata });
    if (this.commitError !== undefined) {
      throw this.commitError;
    }
  }

  async releaseStock(reservationId: string, metadata: Metadata): Promise<void> {
    this.calls.push({ method: "releaseStock", arg: reservationId, metadata });
    if (this.releaseError !== undefined) {
      throw this.releaseError;
    }
  }

  callsOf(method: string): { arg: unknown; metadata?: Metadata }[] {
    return this.calls
      .filter((call) => call.method === method)
      .map((call) => ({ arg: call.arg, metadata: call.metadata }));
  }
}

// ---------------------------------------------------------------------------
// Factories / harness
// ---------------------------------------------------------------------------

export function caller(
  role: UserRole = UserRole.Customer,
  userId = `u-${randomUUID().slice(0, 8)}`
): UserContext {
  return { userId, userName: userId, role };
}

/** Inbound call metadata carrying `authorization` verbatim. */
export function callMetadata(token = `Bearer tok-${randomUUID().slice(0, 8)}`) {
  const metadata = new Metadata();
  metadata.add("authorization", token);
  return metadata;
}

export function seedCatalogBook(
  catalog: FakeCatalogClient,
  overrides: Partial<catalogProto.Book> & { bookId: string }
): catalogProto.Book {
  const book: catalogProto.Book = {
    bookName: `Book ${overrides.bookId.slice(0, 8)}`,
    author: "Test Author",
    price: 10,
    stock: 0,
    available: 0,
    isDeleted: false,
    ...overrides
  };
  catalog.books.set(book.bookId, book);
  return book;
}

export interface HarnessOptions {
  now?: () => Date;
}

export function harness(options: HarnessOptions = {}) {
  const repository = new InMemoryOrderRepository();
  const cart = new FakeCartClient();
  const catalog = new FakeCatalogClient();
  const service = new OrderService({
    repository,
    cart,
    catalog,
    now: options.now
  });
  return { service, repository, cart, catalog };
}

/**
 * A dependency failure in the shape the wire actually delivers: numeric
 * `code`, the message in `details` (grpc-js convention) and structured
 * details as `error-details` trailing metadata — the same contract
 * ERROR_DETAILS_METADATA_KEY defines for the real clients.
 */
export function grpcFailure(
  code: status,
  message: string,
  details?: Record<string, unknown>
): Error {
  const error = Object.assign(new Error(message), {
    code,
    details: message
  });
  if (details) {
    const metadata = new Metadata();
    metadata.set(ERROR_DETAILS_METADATA_KEY, JSON.stringify(details));
    Object.assign(error, { metadata });
  }
  return error;
}

// ---------------------------------------------------------------------------
// gRPC error matchers
// ---------------------------------------------------------------------------

export function grpcCode(error: unknown): number | undefined {
  const err = error as {
    code?: number;
    error?: { code?: number };
    getError?: () => { code?: number };
  };
  return err?.code ?? err?.error?.code ?? err?.getError?.()?.code;
}

export async function catchGrpcError(
  promise: Promise<unknown>
): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a gRPC error, but the call succeeded");
}

export async function expectGrpcError(
  promise: Promise<unknown>,
  expected: status
): Promise<void> {
  const error = await catchGrpcError(promise);
  expect(grpcCode(error)).toBe(expected);
}

/**
 * Structured `details` carried inside the RpcException payload (e.g.
 * `{ missingBookIds: [...] }`). Reads the same error shapes as {@link grpcCode}.
 */
export function errorDetails(
  error: unknown
): Record<string, unknown> | undefined {
  const err = error as {
    details?: Record<string, unknown>;
    error?: { details?: Record<string, unknown> };
    getError?: () => { details?: Record<string, unknown> };
  };
  return err?.details ?? err?.error?.details ?? err?.getError?.()?.details;
}

/** Whether a thrown error mentions `text` in message or serialized details. */
export function errorMentions(error: unknown, text: string): boolean {
  const message =
    typeof (error as { message?: unknown })?.message === "string"
      ? (error as { message: string }).message
      : "";
  if (message.includes(text)) {
    return true;
  }
  try {
    return JSON.stringify(error).includes(text);
  } catch {
    return false;
  }
}
