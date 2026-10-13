import { randomUUID } from "node:crypto";
import { Kafka, Partitioners } from "kafkajs";
import type { DomainEvent, EventType } from "@book-shop/contracts";
import type { EventPublisher } from "./outbox-relay";

/**
 * Minimal Kafka surface the publisher needs — any kafkajs `Kafka` client
 * satisfies it, and tests can inject a fake producer without module mocks.
 */
export interface KafkaLike {
  producer(config?: { createPartitioner?: unknown }): ProducerLike;
}

export interface ProducerLike {
  connect(): Promise<unknown>;
  send(args: {
    topic: string;
    messages: { key?: string; value: string }[];
  }): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

export interface KafkaEventPublisherOptions {
  brokers: string[];
  /** Kafka clientId. */
  clientId?: string;
  /**
   * Payload field used as the message key so all events for one entity
   * share a partition and stay ordered (e.g. "userId" in auth,
   * "bookId" in catalog). Omit for keyless publishing.
   */
  keyField?: string;
  /**
   * kafkajs retry config. The default bounds the connect retry burst so a
   * dead broker fails fast and the next relay tick can try again instead
   * of queueing forever.
   */
  retry?: { retries: number; initialRetryTime: number };
}

/**
 * EventPublisher over a kafkajs Producer (spec §4 of the outbox services).
 * The producer connects LAZILY on first publish: the service must boot and
 * serve RPCs while the broker is down — outbox rows accumulate and the
 * relay retries. LegacyPartitioner pins the pre-v2 key hash and silences
 * the KafkaJS v2 partitioner warning (message keys are deliberate).
 */
export class KafkaEventPublisher implements EventPublisher {
  private readonly kafka: KafkaLike;
  private readonly keyField?: string;
  private producer?: ProducerLike;
  private connecting?: Promise<ProducerLike>;

  constructor(options: KafkaEventPublisherOptions, kafka?: KafkaLike) {
    this.kafka =
      kafka ??
      new Kafka({
        clientId: options.clientId,
        brokers: options.brokers,
        retry: options.retry ?? { retries: 5, initialRetryTime: 300 }
      });
    this.keyField = options.keyField;
  }

  async publish(
    topic: string,
    message: { eventType: string; payload: unknown; occurredAt?: Date }
  ): Promise<void> {
    const producer = await this.ensureProducer();
    const event: DomainEvent<unknown> = {
      eventId: randomUUID(),
      eventType: message.eventType as EventType,
      // Event time = outbox row creation (when the mutation committed), not
      // relay publish time — rows can sit unpublished for a while.
      occurredAt: new Date(message.occurredAt ?? Date.now()).toISOString(),
      payload: message.payload
    };
    await producer.send({
      topic,
      messages: [
        {
          key: this.keyFromPayload(message.payload),
          value: JSON.stringify(event)
        }
      ]
    });
  }

  /** Graceful shutdown — safe when the producer never connected. */
  async close(): Promise<void> {
    try {
      await this.producer?.disconnect();
    } finally {
      this.producer = undefined;
      this.connecting = undefined;
    }
  }

  private keyFromPayload(payload: unknown): string | undefined {
    if (!this.keyField || typeof payload !== "object" || payload === null) {
      return undefined;
    }
    const value = (payload as Record<string, unknown>)[this.keyField];
    return typeof value === "string" ? value : undefined;
  }

  private ensureProducer(): Promise<ProducerLike> {
    if (this.producer) {
      return Promise.resolve(this.producer);
    }
    if (!this.connecting) {
      this.connecting = (async () => {
        const producer = this.kafka.producer({
          createPartitioner: Partitioners.LegacyPartitioner
        });
        await producer.connect();
        this.producer = producer;
        return producer;
      })();
      // a failed connect must not poison future retries — clear the
      // in-flight promise so the next publish attempt reconnects
      this.connecting.catch(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }
}
