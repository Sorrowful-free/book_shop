import { randomUUID } from "node:crypto";
import { Kafka, type Producer } from "kafkajs";
import type { EventPublisher } from "@book-shop/common";
import type { DomainEvent, EventType } from "@book-shop/contracts";

/**
 * EventPublisher over a kafkajs Producer. The producer connects LAZILY on
 * first publish (spec §4/§10): the service must boot and serve RPCs while
 * the broker is down — outbox rows accumulate and the relay retries.
 */
export class KafkaEventPublisher implements EventPublisher {
  private readonly kafka: Kafka;
  private producer?: Producer;
  private connecting?: Promise<Producer>;

  constructor(brokers: string[], clientId = "auth-service") {
    this.kafka = new Kafka({
      clientId,
      brokers,
      // bound the connect retry burst so a dead broker fails fast and the
      // next relay tick can try again instead of queueing forever
      retry: { retries: 5, initialRetryTime: 300 }
    });
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
    // Key by userId so all events for one user land on the same partition
    // and stay ordered.
    const payload = message.payload as { userId?: unknown } | null;
    const key =
      payload && typeof payload.userId === "string"
        ? payload.userId
        : undefined;
    await producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(event) }]
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

  private ensureProducer(): Promise<Producer> {
    if (this.producer) {
      return Promise.resolve(this.producer);
    }
    if (!this.connecting) {
      this.connecting = (async () => {
        const producer = this.kafka.producer();
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
