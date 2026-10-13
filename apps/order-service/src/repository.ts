// Repository contract — the OrderRepository interface and the record types
// shared by every adapter. The production adapter is Prisma-backed
// (prisma.repository.ts); unit tests substitute an in-memory test double.
// Write methods that publish domain events take a `buildEvent` callback so
// the mutation and the outbox row land in ONE database transaction
// (transactional outbox, spec §4).

import type { EventType } from "@book-shop/contracts";

export type OrderStatus = "PENDING" | "PAID" | "CANCELLED";

export interface OrderItemRecord {
  bookId: string;
  bookName: string;
  author: string;
  /** Decimal(10,2) at rest; plain number across the repository boundary. */
  price: number;
  amount: number;
}

export interface OrderRecord {
  id: string;
  userId: string;
  status: OrderStatus;
  totalPrice: number;
  reservationId: string | null;
  idempotencyKey: string;
  /** Item snapshot at checkout; always returned ordered by bookId ASC (F-O5). */
  items: OrderItemRecord[];
  createdAt: Date;
  paidAt: Date | null;
  cancelledAt: Date | null;
}

export interface NewOrder {
  userId: string;
  idempotencyKey: string;
  reservationId: string | null;
  items: OrderItemRecord[];
  totalPrice: number;
}

export interface PageRequest {
  offset: number;
  limit: number;
}

export interface OutboxEventInput {
  eventType: EventType;
  payload: unknown;
}

/**
 * Result of a guarded status transition: `order` is always the CURRENT
 * record. `transitioned` is true only when the row was still in `expected`
 * state and got updated (outbox row written in the same transaction).
 * A concurrent transition (pay racing cancel) loses the guard and sees the
 * post-race state — the service answers idempotently instead of emitting a
 * duplicate or contradicting event.
 */
export interface TransitionResult {
  order: OrderRecord;
  transitioned: boolean;
}

export interface OrderRepository {
  findOrderById(id: string): Promise<OrderRecord | null>;
  /** The (user_id, idempotency_key) unique key — checkout dedup. */
  findOrderByIdempotencyKey(
    userId: string,
    idempotencyKey: string
  ): Promise<OrderRecord | null>;
  /**
   * Caller's orders, `created_at DESC, id DESC` (F-O5 — newest first with a
   * stable id tiebreak so pagination does not drift).
   */
  listOrdersByUser(
    userId: string,
    page: PageRequest
  ): Promise<{ orders: OrderRecord[]; total: number }>;
  /**
   * Persists a PENDING order + its `order.order.created` outbox row in one
   * transaction. Throws a unique-violation (P2002-shaped) error when the
   * (user_id, idempotency_key) pair already exists — the checkout saga maps
   * that race into "release the orphan reservation, return the winner".
   */
  createOrderWithOutbox(
    order: NewOrder,
    buildEvent: (created: OrderRecord) => OutboxEventInput
  ): Promise<OrderRecord>;
  /**
   * Guarded `expected → next` transition + outbox row in one transaction;
   * sets paid_at/cancelled_at to `now` on a real transition. Returns null
   * when the order does not exist.
   */
  transitionOrderWithOutbox(
    id: string,
    expected: OrderStatus,
    next: OrderStatus,
    now: Date,
    buildEvent: (order: OrderRecord) => OutboxEventInput
  ): Promise<TransitionResult | null>;
}
