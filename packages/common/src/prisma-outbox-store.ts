import type { OutboxRow, OutboxStore } from "./outbox-relay";

interface RawTx {
  $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * Minimal Prisma surface the outbox store needs — any PrismaClient whose
 * schema carries the standard `outbox` model satisfies it (auth_db,
 * catalog_db, order_db all share the same table shape). Kept narrow so the
 * common package never imports a service's generated client.
 */
export interface OutboxPrismaClient {
  $transaction<R>(fn: (tx: RawTx) => Promise<R>): Promise<R>;
  outbox: {
    updateMany(args: {
      where: { id: { in: string[] }; publishedAt?: Date | null };
      data: { publishedAt: Date };
    }): Promise<unknown>;
  };
}

/**
 * OutboxStore over the prisma `outbox` table for OutboxRelay (spec §4).
 * Batch selection uses SELECT … FOR UPDATE SKIP LOCKED so concurrent relay
 * instances don't fight over the same rows; publishing stays at-least-once
 * regardless (consumers must be idempotent).
 */
export class PrismaOutboxStore implements OutboxStore {
  constructor(private readonly prisma: OutboxPrismaClient) {}

  fetchUnpublished(limit: number): Promise<OutboxRow[]> {
    return this.prisma.$transaction(
      (tx) => tx.$queryRaw<OutboxRow[]>`
        SELECT id, event_type AS "eventType", payload,
               created_at AS "occurredAt"
        FROM outbox
        WHERE published_at IS NULL
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `
    );
  }

  async markPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    // `publishedAt: null` in the WHERE keeps an already-stamped row's
    // original publish time if the same batch is ever marked twice.
    await this.prisma.outbox.updateMany({
      where: { id: { in: ids }, publishedAt: null },
      data: { publishedAt: new Date() }
    });
  }
}
