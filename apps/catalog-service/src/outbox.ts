// Transactional-outbox plumbing (spec §4): mutations write outbox rows in
// the same DB transaction; OutboxRelay (@book-shop/common) drains them via
// this store and publishes DomainEvent JSON through KafkaEventPublisher.
// The Kafka producer connects lazily on first publish so the service boots
// and serves RPCs with a dead broker — unpublished rows are retried later.

import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Kafka, type Producer } from "kafkajs";
import { Prisma } from "./generated/prisma";
import type { DomainEvent, EventType } from "@book-shop/contracts";
import type { EventPublisher, OutboxRow, OutboxStore } from "@book-shop/common";
import { PrismaService } from "./prisma.service";

interface OutboxDbRow {
  id: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date;
}

@Injectable()
export class PrismaOutboxStore implements OutboxStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claims unpublished rows. `FOR UPDATE SKIP LOCKED` keeps concurrent relay
   * instances from grabbing the same rows while the fetch transaction runs;
   * publishing is at-least-once regardless (consumers must be idempotent).
   */
  async fetchUnpublished(limit: number): Promise<OutboxRow[]> {
    const rows = await this.prisma.$transaction((tx) =>
      tx.$queryRaw<OutboxDbRow[]>(Prisma.sql`
        SELECT id, event_type AS "eventType", payload,
               created_at AS "occurredAt"
        FROM outbox
        WHERE published_at IS NULL
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`)
    );
    return rows.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      payload: row.payload,
      occurredAt: row.occurredAt
    }));
  }

  async markPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.prisma.outbox.updateMany({
      where: { id: { in: ids } },
      data: { publishedAt: new Date() }
    });
  }
}

export class KafkaEventPublisher implements EventPublisher {
  private readonly producer: Producer;
  private connection: Promise<unknown> | null = null;

  constructor(brokers: string[], clientId = "catalog-service") {
    const kafka = new Kafka({ clientId, brokers });
    this.producer = kafka.producer();
  }

  async publish(
    topic: string,
    message: { eventType: string; payload: unknown; occurredAt?: Date }
  ): Promise<void> {
    // Lazy connect: a dead broker must not fail app boot; a failed connect is
    // reset so the next relay tick retries from scratch.
    this.connection ??= this.producer.connect().catch((error: unknown) => {
      this.connection = null;
      throw error;
    });
    await this.connection;
    const event: DomainEvent<unknown> = {
      eventId: randomUUID(),
      eventType: message.eventType as EventType,
      // Event time = outbox row creation (when the mutation committed), not
      // the relay publish time — rows can sit unpublished for a while.
      occurredAt: new Date(message.occurredAt ?? Date.now()).toISOString(),
      payload: message.payload
    };
    // Key by bookId so all events for one book land on the same partition
    // and stay ordered.
    const payload = message.payload as { bookId?: unknown } | null;
    const key =
      payload && typeof payload.bookId === "string"
        ? payload.bookId
        : undefined;
    await this.producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(event) }]
    });
  }

  async close(): Promise<void> {
    try {
      await this.producer.disconnect();
    } catch {
      // never connected — nothing to close
    }
  }
}
