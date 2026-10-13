// Prisma-backed OrderRepository — the production adapter for order_db
// (spec §3). Every mutation that emits a domain event runs the entity write
// AND the outbox insert inside ONE prisma transaction (transactional
// outbox, spec §4).

import { Injectable } from "@nestjs/common";
import { Prisma } from "./generated/prisma";
import type {
  Order as PrismaOrder,
  OrderItem as PrismaOrderItem
} from "./generated/prisma";
import type {
  NewOrder,
  OrderRecord,
  OrderRepository,
  OrderStatus,
  OutboxEventInput,
  PageRequest,
  TransitionResult
} from "./repository";
import { PrismaService } from "./prisma.service";

type PrismaOrderWithItems = PrismaOrder & { items: PrismaOrderItem[] };

/**
 * Items are sorted in the mapper too (not only via `include.orderBy`) so the
 * `book_id ASC` contract (F-O5) holds no matter how a record was produced.
 */
function toOrderRecord(order: PrismaOrderWithItems): OrderRecord {
  return {
    id: order.id,
    userId: order.userId,
    status: order.status as OrderStatus,
    totalPrice: Number(order.totalPrice),
    reservationId: order.reservationId,
    idempotencyKey: order.idempotencyKey,
    items: order.items
      .map((item) => ({
        bookId: item.bookId,
        bookName: item.bookName,
        author: item.author,
        price: Number(item.price),
        amount: item.amount
      }))
      .sort((a, b) => a.bookId.localeCompare(b.bookId)),
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    cancelledAt: order.cancelledAt
  };
}

const ITEMS_ASC = { orderBy: { bookId: "asc" as const } };

@Injectable()
export class PrismaOrderRepository implements OrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findOrderById(id: string): Promise<OrderRecord | null> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: ITEMS_ASC }
    });
    return order ? toOrderRecord(order) : null;
  }

  async findOrderByIdempotencyKey(
    userId: string,
    idempotencyKey: string
  ): Promise<OrderRecord | null> {
    const order = await this.prisma.order.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      include: { items: ITEMS_ASC }
    });
    return order ? toOrderRecord(order) : null;
  }

  /** F-O5: newest first, stable id tiebreak — pagination must not drift. */
  async listOrdersByUser(
    userId: string,
    page: PageRequest
  ): Promise<{ orders: OrderRecord[]; total: number }> {
    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where: { userId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: page.offset,
        take: page.limit,
        include: { items: ITEMS_ASC }
      }),
      this.prisma.order.count({ where: { userId } })
    ]);
    return { orders: orders.map(toOrderRecord), total };
  }

  async createOrderWithOutbox(
    order: NewOrder,
    buildEvent: (created: OrderRecord) => OutboxEventInput
  ): Promise<OrderRecord> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          userId: order.userId,
          idempotencyKey: order.idempotencyKey,
          reservationId: order.reservationId,
          totalPrice: new Prisma.Decimal(order.totalPrice),
          items: {
            create: order.items.map((item) => ({
              bookId: item.bookId,
              bookName: item.bookName,
              author: item.author,
              price: new Prisma.Decimal(item.price),
              amount: item.amount
            }))
          }
        },
        include: { items: ITEMS_ASC }
      });
      const record = toOrderRecord(created);
      await this.insertOutbox(tx, buildEvent(record));
      return record;
    });
  }

  /**
   * `UPDATE … WHERE status = expected` is the transition guard: a concurrent
   * pay/cancel that already moved the row affects 0 records, and the caller
   * gets `transitioned: false` with the post-race record — no duplicate
   * outbox events, no phantom state overwrites.
   */
  async transitionOrderWithOutbox(
    id: string,
    expected: OrderStatus,
    next: OrderStatus,
    now: Date,
    buildEvent: (order: OrderRecord) => OutboxEventInput
  ): Promise<TransitionResult | null> {
    return this.prisma.$transaction<TransitionResult | null>(async (tx) => {
      const existing = await tx.order.findUnique({ where: { id } });
      if (!existing) {
        return null;
      }
      const data =
        next === "PAID"
          ? { status: "PAID" as const, paidAt: now }
          : { status: "CANCELLED" as const, cancelledAt: now };
      const updated = await tx.order.updateMany({
        where: { id, status: expected },
        data
      });
      const fresh = await tx.order.findUniqueOrThrow({
        where: { id },
        include: { items: ITEMS_ASC }
      });
      const record = toOrderRecord(fresh);
      if (updated.count === 0) {
        return { order: record, transitioned: false };
      }
      await this.insertOutbox(tx, buildEvent(record));
      return { order: record, transitioned: true };
    });
  }

  private async insertOutbox(
    tx: Prisma.TransactionClient,
    event: OutboxEventInput
  ): Promise<void> {
    await tx.outbox.create({
      data: {
        eventType: event.eventType,
        payload: event.payload as Prisma.InputJsonValue
      }
    });
  }
}
