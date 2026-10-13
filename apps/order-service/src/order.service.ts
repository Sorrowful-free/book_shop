// Core order logic (spec docs/specs/04-order-service.md + fixes F-O1..F-O5).
//
// DB access goes through the OrderRepository contract (Prisma adapter in
// production, in-memory test double in unit tests); cart/catalog calls go
// through the CartClient/CatalogClient interfaces (src/clients.ts) — all
// mocked in unit tests. Errors are RpcException objects carrying
// { code, message, details? } plus the same `code` assigned top-level.
//
// `caller` is the already-verified JWT user context — `null` when no valid
// token was supplied (mapped to UNAUTHENTICATED). `metadata` is the inbound
// gRPC call metadata; only `authorization` is forwarded to dependencies.
//
// Dependency errors (F-O4): domain answers pass through with code, message
// and structured details intact; only transport failures (connection
// refused, deadline) collapse to UNAVAILABLE.

import { Injectable } from "@nestjs/common";
import { Metadata, status } from "@grpc/grpc-js";
import { RpcException } from "@nestjs/microservices";
import type { UserContext } from "@book-shop/common";
import {
  EVENT_TYPES,
  UserRole,
  orderProto,
  type OrderCancelledPayload,
  type OrderCreatedPayload,
  type OrderPaidPayload
} from "@book-shop/contracts";
import type { Timestamp } from "@book-shop/contracts/gen/google/protobuf/timestamp";
import type { CartClient, CatalogClient } from "./clients";
import {
  ERROR_DETAILS_METADATA_KEY,
  forwardedAuthMetadata,
  grpcErrorCode,
  grpcErrorDetails,
  grpcErrorMessage,
  isTransportError
} from "./clients";
import type {
  NewOrder,
  OrderRecord,
  OrderRepository,
  OrderStatus,
  OutboxEventInput,
  TransitionResult
} from "./repository";

export interface OrderServiceDeps {
  repository: OrderRepository;
  cart: CartClient;
  catalog: CatalogClient;
  /** Injectable clock — lets unit tests assert paid_at/cancelled_at. */
  now?: () => Date;
}

/** limit upper bound — shared with the ListMyOrders DTO. */
export const MAX_LIMIT = 100;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rpcError(
  code: status,
  message: string,
  details?: Record<string, unknown>
): RpcException {
  // Same convention as the other services: { code, message, details? }
  // payload plus the code assigned top-level (grpc-js reads `error.code`
  // when the exception escapes raw). Additionally, structured details are
  // copied into trailing metadata — the wire only carries `code`, the
  // `details` message string and trailers, so this is the channel that lets
  // e.g. `unavailableBookIds` reach the caller (F-O4). The Metadata object
  // must live INSIDE the payload: the exception filter emits getError() as
  // the grpc-js error, so a `.metadata` assigned to the exception itself
  // would be dropped — only payload properties reach serverErrorToStatus.
  const payload: Record<string, unknown> = { code, message };
  if (details) {
    payload.details = details;
    const trailers = new Metadata();
    trailers.set(ERROR_DETAILS_METADATA_KEY, JSON.stringify(details));
    payload.metadata = trailers;
  }
  return Object.assign(new RpcException(payload), { code });
}

function toTimestamp(date: Date): Timestamp {
  const ms = date.getTime();
  return {
    seconds: Math.floor(ms / 1000),
    nanos: (ms % 1000) * 1_000_000
  };
}

/** Prisma unique-constraint violation (duck-typed — no client import). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

const PROTO_STATUS: Record<OrderStatus, orderProto.OrderStatus> = {
  PENDING: orderProto.OrderStatus.ORDER_STATUS_PENDING,
  PAID: orderProto.OrderStatus.ORDER_STATUS_PAID,
  CANCELLED: orderProto.OrderStatus.ORDER_STATUS_CANCELLED
};

@Injectable()
export class OrderService {
  private readonly repository: OrderRepository;
  private readonly cart: CartClient;
  private readonly catalog: CatalogClient;
  private readonly now: () => Date;

  constructor(deps: OrderServiceDeps) {
    this.repository = deps.repository;
    this.cart = deps.cart;
    this.catalog = deps.catalog;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Checkout saga (spec §2): cart.GetCart → catalog.GetBooksByIds snapshot
   * → catalog.ReserveStock → persist PENDING + outbox order.order.created —
   * all dependency calls carry the caller's `authorization` verbatim.
   * Idempotent on (user_id, idempotency_key): a repeat returns the existing
   * order without a new saga; a lost race on the unique index releases the
   * orphan reservation and returns the winner.
   */
  async checkout(
    request: orderProto.CheckoutRequest,
    caller: UserContext | null,
    metadata?: Metadata
  ): Promise<orderProto.Order> {
    const user = this.requireCaller(caller);
    this.assertUuid(request.idempotencyKey, "idempotency_key");

    // Idempotent repeat — the unique index is the real guarantee, this
    // lookup is the cheap fast path that skips the whole saga.
    const existing = await this.repository.findOrderByIdempotencyKey(
      user.userId,
      request.idempotencyKey
    );
    if (existing) {
      return this.toProto(existing);
    }

    const auth = forwardedAuthMetadata(metadata);
    const cart = await this.callDep("cart-service", () =>
      this.cart.getCart(auth)
    );
    if (!cart.items || cart.items.length === 0) {
      throw rpcError(status.FAILED_PRECONDITION, "cart is empty");
    }

    // Aggregate positions per book first — a duplicated book_id in the cart
    // must produce a single snapshot/reservation position.
    const amounts = new Map<string, number>();
    for (const item of cart.items) {
      amounts.set(item.bookId, (amounts.get(item.bookId) ?? 0) + item.amount);
    }
    // F-O5: fixed item order — book_id ASC ends up in the persisted snapshot
    // and therefore in every Order response.
    const bookIds = [...amounts.keys()].sort((a, b) => a.localeCompare(b));

    const books = await this.callDep("catalog-service", () =>
      this.catalog.getBooksByIds(bookIds, auth)
    );
    const byId = new Map(books.map((book) => [book.bookId, book]));
    const missing = bookIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      // The cart referenced a book the catalog no longer knows — mirror
      // GetBooksByIds' own NOT_FOUND + details contract (F-O4).
      throw rpcError(
        status.NOT_FOUND,
        `books not found: ${missing.join(", ")}`,
        { missingBookIds: missing }
      );
    }

    const items = bookIds.map((id) => {
      const book = byId.get(id)!;
      return {
        bookId: id,
        bookName: book.bookName,
        author: book.author,
        price: book.price,
        amount: amounts.get(id)!
      };
    });
    // Money: numbers at the edge, Decimal(10,2) at rest — round the double
    // sum to cents before it hits the column.
    const totalPrice =
      Math.round(
        items.reduce((sum, item) => sum + item.price * item.amount, 0) * 100
      ) / 100;

    const reservation = await this.callDep("catalog-service", () =>
      this.catalog.reserveStock(
        items.map((item) => ({ bookId: item.bookId, amount: item.amount })),
        auth
      )
    );

    const draft: NewOrder = {
      userId: user.userId,
      idempotencyKey: request.idempotencyKey,
      reservationId: reservation.reservationId,
      items,
      totalPrice
    };
    try {
      const created = await this.repository.createOrderWithOutbox(
        draft,
        (record) => this.orderCreatedEvent(record)
      );
      return this.toProto(created);
    } catch (error) {
      // Persist failed — the reservation is orphaned. Release it
      // best-effort whatever the cause was (spec §2 compensation).
      await this.tryRelease(reservation.reservationId, auth);
      if (isUniqueViolation(error)) {
        // A parallel checkout with the same key won — return its order
        // instead of surfacing the constraint violation (spec §2).
        const winner = await this.repository.findOrderByIdempotencyKey(
          user.userId,
          request.idempotencyKey
        );
        if (winner) {
          return this.toProto(winner);
        }
      }
      // A raw Prisma error would escape as UNKNOWN — surface a clean
      // INTERNAL instead; the orphan reservation was already released.
      throw rpcError(status.INTERNAL, "failed to persist order");
    }
  }

  /** Own order or ADMIN/EMPLOYER (spec §6). */
  async getOrder(
    request: orderProto.GetOrderRequest,
    caller: UserContext | null
  ): Promise<orderProto.Order> {
    const user = this.requireCaller(caller);
    this.assertUuid(request.orderId, "order_id");
    const order = await this.findOwnedOrder(request.orderId, user);
    return this.toProto(order);
  }

  /** Caller's orders, newest first (F-O5). */
  async listMyOrders(
    request: orderProto.ListMyOrdersRequest,
    caller: UserContext | null
  ): Promise<orderProto.ListMyOrdersResponse> {
    const user = this.requireCaller(caller);
    // proto3 implicit presence: a literal `offset: 0` is never serialized —
    // normalize to the default.
    const offset = request.offset ?? 0;
    this.assertPage(offset, request.limit);
    const { orders, total } = await this.repository.listOrdersByUser(
      user.userId,
      { offset, limit: request.limit }
    );
    return { orders: orders.map((order) => this.toProto(order)), total };
  }

  /**
   * Payment emulation (spec §2 + fixes):
   * - PENDING → CommitStock → PAID + order.paid
   * - already PAID → returns the order without touching catalog (F-O3)
   * - CANCELLED → FAILED_PRECONDITION (terminal)
   * - reservation expired (NOT_FOUND) → CANCELLED + order.cancelled, FP out
   * - CommitStock FAILED_PRECONDITION (F-O1) → best-effort ReleaseStock,
   *   CANCELLED + order.cancelled, FP out
   */
  async payOrder(
    request: orderProto.PayOrderRequest,
    caller: UserContext | null,
    metadata?: Metadata
  ): Promise<orderProto.Order> {
    const user = this.requireCaller(caller);
    this.assertUuid(request.orderId, "order_id");
    const order = await this.findOwnedOrder(request.orderId, user);
    // F-O3: the money RPC is idempotent — a lost successful response must
    // not punish the retry with an error.
    if (order.status === "PAID") {
      return this.toProto(order);
    }
    if (order.status === "CANCELLED") {
      throw rpcError(
        status.FAILED_PRECONDITION,
        `order ${order.id} is cancelled`
      );
    }
    const auth = forwardedAuthMetadata(metadata);
    try {
      if (!order.reservationId) {
        // Persisted PENDING without a reservation — unfulfillable, treat it
        // like an expired reservation below.
        throw rpcError(status.NOT_FOUND, "order has no reservation");
      }
      await this.catalog.commitStock(order.reservationId, auth);
    } catch (error) {
      if (isTransportError(error)) {
        throw this.depError("catalog-service", error);
      }
      const code = grpcErrorCode(error);
      if (code === status.FAILED_PRECONDITION) {
        // F-O1: stock no longer covers the reserved amount — the order can
        // never be fulfilled. Release the still-ACTIVE reservation
        // best-effort, cancel the order, FP to the caller.
        if (order.reservationId) {
          await this.tryRelease(order.reservationId, auth);
        }
      }
      if (code === status.FAILED_PRECONDITION || code === status.NOT_FOUND) {
        // F-O1 + spec §2: reservation expired or uncommittable → CANCELLED;
        // the caller always sees FAILED_PRECONDITION regardless of which
        // of the two catalog codes fired.
        await this.cancelOrderRecord(order.id);
        throw rpcError(
          status.FAILED_PRECONDITION,
          grpcErrorMessage(error),
          grpcErrorDetails(error)
        );
      }
      throw this.depError("catalog-service", error);
    }
    const result = await this.repository.transitionOrderWithOutbox(
      order.id,
      "PENDING",
      "PAID",
      this.now(),
      (record) => this.orderPaidEvent(record)
    );
    return this.answerFromTransition(result, order.id, "PAID");
  }

  /**
   * Cancellation (spec §2 + F-O2):
   * - PENDING → ReleaseStock → CANCELLED + order.cancelled
   * - ReleaseStock NOT_FOUND (reservation expired) → still CANCELLED
   * - ReleaseStock FAILED_PRECONDITION:
   *   - details.reservationStatus "COMMITTED" → self-heal to PAID +
   *     order.paid (stock was already debited — reflect it honestly)
   *   - "RELEASED" / absent / unrecognized → CANCELLED (compensation done)
   * - PAID/CANCELLED order → FAILED_PRECONDITION
   */
  async cancelOrder(
    request: orderProto.CancelOrderRequest,
    caller: UserContext | null,
    metadata?: Metadata
  ): Promise<orderProto.Order> {
    const user = this.requireCaller(caller);
    this.assertUuid(request.orderId, "order_id");
    const order = await this.findOwnedOrder(request.orderId, user);
    if (order.status !== "PENDING") {
      throw rpcError(
        status.FAILED_PRECONDITION,
        `order ${order.id} is ${order.status.toLowerCase()}, only pending orders can be cancelled`
      );
    }
    const auth = forwardedAuthMetadata(metadata);
    if (order.reservationId) {
      try {
        await this.catalog.releaseStock(order.reservationId, auth);
      } catch (error) {
        const code = grpcErrorCode(error);
        if (isTransportError(error)) {
          throw this.depError("catalog-service", error);
        }
        if (code === status.FAILED_PRECONDITION) {
          // F-O2: only the structured `reservationStatus` detail is
          // trusted — an error message that merely mentions a status is
          // not evidence of the reservation's state and falls through to
          // the conservative CANCELLED below.
          const observed = grpcErrorDetails(error)?.reservationStatus;
          if (
            typeof observed === "string" &&
            observed.toUpperCase() === "COMMITTED"
          ) {
            // F-O2 self-heal: the reservation was already committed — the
            // stock is gone, so the honest terminal state is PAID, not
            // CANCELLED, and the event is order.paid.
            const healed = await this.repository.transitionOrderWithOutbox(
              order.id,
              "PENDING",
              "PAID",
              this.now(),
              (record) => this.orderPaidEvent(record)
            );
            return this.answerFromTransition(healed, order.id, "PAID");
          }
          // "RELEASED" or unrecognizable details → the reservation is
          // already compensated (or the catalog is too old to say) — the
          // conservative base-spec answer is CANCELLED either way.
        } else if (code !== status.NOT_FOUND) {
          // NOT_FOUND means the reservation is already gone (expired) —
          // the compensation goal is met. Anything else domain-shaped is
          // passed through to the caller.
          throw this.depError("catalog-service", error);
        }
      }
    }
    const result = await this.repository.transitionOrderWithOutbox(
      order.id,
      "PENDING",
      "CANCELLED",
      this.now(),
      (record) => this.orderCancelledEvent(record)
    );
    return this.answerFromTransition(result, order.id, "CANCELLED");
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private requireCaller(caller: UserContext | null): UserContext {
    if (!caller) {
      throw rpcError(
        status.UNAUTHENTICATED,
        "missing or invalid authentication token"
      );
    }
    return caller;
  }

  /**
   * NOT_FOUND for a missing order, PERMISSION_DENIED when it belongs to
   * someone else and the caller is not ADMIN/EMPLOYER (spec §6).
   */
  private async findOwnedOrder(
    orderId: string,
    caller: UserContext
  ): Promise<OrderRecord> {
    const order = await this.repository.findOrderById(orderId);
    if (!order) {
      throw rpcError(status.NOT_FOUND, `order ${orderId} not found`);
    }
    if (
      order.userId !== caller.userId &&
      caller.role !== UserRole.Admin &&
      caller.role !== UserRole.Employer
    ) {
      throw rpcError(
        status.PERMISSION_DENIED,
        `order ${orderId} belongs to another user`
      );
    }
    return order;
  }

  /**
   * Wrap a dependency call so domain answers pass through intact (F-O4) and
   * only transport failures surface as UNAVAILABLE.
   */
  private async callDep<T>(dep: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw this.depError(dep, error);
    }
  }

  /**
   * F-O4 error model: preserve the dependency's code/message/details for
   * domain answers; UNAVAILABLE is reserved for transport failures
   * (connection refused, deadline exceeded, non-grpc call failures).
   */
  private depError(dep: string, error: unknown): RpcException {
    if (isTransportError(error)) {
      return rpcError(status.UNAVAILABLE, `${dep} is unavailable`);
    }
    return rpcError(
      grpcErrorCode(error) ?? status.UNKNOWN,
      grpcErrorMessage(error),
      grpcErrorDetails(error)
    );
  }

  /**
   * Best-effort ReleaseStock used for saga compensation — errors are
   * ignored by design (e.g. NOT_FOUND when the reservation already
   * expired): the compensation outcome never changes the caller's answer.
   */
  private async tryRelease(
    reservationId: string,
    auth: Metadata
  ): Promise<void> {
    try {
      await this.catalog.releaseStock(reservationId, auth);
    } catch {
      // best-effort — the reservation may already be gone
    }
  }

  /**
   * Mark an order CANCELLED + outbox order.cancelled when the reservation
   * is gone (expired) or uncommittable (F-O1). A lost transition race just
   * means the state already moved — the caller's FAILED_PRECONDITION
   * stands either way.
   */
  private async cancelOrderRecord(orderId: string): Promise<void> {
    await this.repository.transitionOrderWithOutbox(
      orderId,
      "PENDING",
      "CANCELLED",
      this.now(),
      (record) => this.orderCancelledEvent(record)
    );
  }

  /**
   * Answer a pay/cancel RPC from a guarded transition result: the real
   * transition returns the fresh record; a lost race answers from the
   * observed terminal state — PAID reads as success for a pay caller,
   * anything else is the spec's FAILED_PRECONDITION.
   */
  private answerFromTransition(
    result: TransitionResult | null,
    orderId: string,
    succeededAs: OrderStatus
  ): orderProto.Order {
    if (!result) {
      // The order vanished between the ownership check and the transition.
      throw rpcError(status.NOT_FOUND, `order ${orderId} not found`);
    }
    if (result.transitioned || result.order.status === succeededAs) {
      return this.toProto(result.order);
    }
    throw rpcError(
      status.FAILED_PRECONDITION,
      `order ${orderId} is ${result.order.status.toLowerCase()}`
    );
  }

  private assertUuid(value: string, field: string): void {
    if (typeof value !== "string" || !UUID_RE.test(value)) {
      throw rpcError(status.INVALID_ARGUMENT, `${field} must be a valid uuid`);
    }
  }

  private assertPage(offset: number, limit: number): void {
    if (!Number.isInteger(offset) || offset < 0) {
      throw rpcError(
        status.INVALID_ARGUMENT,
        "offset must be a non-negative integer"
      );
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw rpcError(
        status.INVALID_ARGUMENT,
        `limit must be an integer between 1 and ${MAX_LIMIT}`
      );
    }
  }

  private toProto(order: OrderRecord): orderProto.Order {
    return {
      orderId: order.id,
      userId: order.userId,
      items: order.items.map((item) => ({
        bookId: item.bookId,
        bookName: item.bookName,
        author: item.author,
        price: item.price,
        amount: item.amount
      })),
      totalPrice: order.totalPrice,
      status: PROTO_STATUS[order.status],
      createdAt: toTimestamp(order.createdAt),
      paidAt: order.paidAt ? toTimestamp(order.paidAt) : undefined,
      cancelledAt: order.cancelledAt
        ? toTimestamp(order.cancelledAt)
        : undefined
    };
  }

  private orderCreatedEvent(record: OrderRecord): OutboxEventInput {
    const payload: OrderCreatedPayload = {
      orderId: record.id,
      userId: record.userId,
      goods: record.items.map((item) => ({
        bookId: item.bookId,
        bookName: item.bookName,
        author: item.author,
        price: item.price,
        amount: item.amount
      })),
      totalPrice: record.totalPrice
    };
    return { eventType: EVENT_TYPES.orderCreated, payload };
  }

  private orderPaidEvent(record: OrderRecord): OutboxEventInput {
    const payload: OrderPaidPayload = {
      orderId: record.id,
      userId: record.userId,
      totalPrice: record.totalPrice
    };
    return { eventType: EVENT_TYPES.orderPaid, payload };
  }

  private orderCancelledEvent(record: OrderRecord): OutboxEventInput {
    const payload: OrderCancelledPayload = {
      orderId: record.id,
      userId: record.userId
    };
    return { eventType: EVENT_TYPES.orderCancelled, payload };
  }
}
