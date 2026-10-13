import { describe, expect, it } from "bun:test";
import { EVENT_TYPES } from "@book-shop/contracts";
import {
  KafkaEventPublisher,
  type KafkaLike,
  type ProducerLike
} from "./kafka-event-publisher";

class FakeProducer implements ProducerLike {
  connects = 0;
  disconnects = 0;
  sent: { topic: string; messages: { key?: string; value: string }[] }[] = [];
  failConnect = false;

  async connect(): Promise<void> {
    if (this.failConnect) {
      throw new Error("broker unreachable");
    }
    this.connects += 1;
  }

  async send(args: {
    topic: string;
    messages: { key?: string; value: string }[];
  }): Promise<void> {
    this.sent.push(args);
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1;
  }
}

function harness(
  options: Partial<ConstructorParameters<typeof KafkaEventPublisher>[0]> = {},
  producer = new FakeProducer()
) {
  const kafka: KafkaLike = {
    producer: () => producer
  };
  const publisher = new KafkaEventPublisher(
    { brokers: ["localhost:9092"], clientId: "test", ...options },
    kafka
  );
  return { publisher, producer };
}

const message = {
  eventType: EVENT_TYPES.userRegistered,
  payload: { userId: "u-1", userName: "vasya" }
};

describe("KafkaEventPublisher", () => {
  it("publishes a DomainEvent JSON keyed by the configured payload field", async () => {
    const { publisher, producer } = harness({ keyField: "userId" });
    const occurredAt = new Date("2030-01-01T00:00:00.000Z");

    await publisher.publish("auth.user.events", { ...message, occurredAt });

    expect(producer.sent).toHaveLength(1);
    const [sent] = producer.sent;
    expect(sent.topic).toBe("auth.user.events");
    expect(sent.messages).toHaveLength(1);
    expect(sent.messages[0].key).toBe("u-1");
    const event = JSON.parse(sent.messages[0].value);
    expect(event.eventType).toBe(EVENT_TYPES.userRegistered);
    expect(event.occurredAt).toBe(occurredAt.toISOString());
    expect(event.payload).toEqual(message.payload);
    expect(event.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("falls back to publish time when the row carries no occurredAt", async () => {
    const { publisher, producer } = harness({ keyField: "userId" });
    const before = Date.now();
    await publisher.publish("auth.user.events", message);
    const event = JSON.parse(producer.sent[0].messages[0].value);
    const occurred = new Date(event.occurredAt).getTime();
    expect(occurred).toBeGreaterThanOrEqual(before);
    expect(occurred).toBeLessThanOrEqual(Date.now());
  });

  it("sends an undefined key for keyless publishers or missing fields", async () => {
    const { publisher, producer } = harness(); // no keyField
    await publisher.publish("auth.user.events", message);
    expect(producer.sent[0].messages[0].key).toBeUndefined();
  });

  it("connects lazily once and reuses the producer", async () => {
    const { publisher, producer } = harness({ keyField: "userId" });
    expect(producer.connects).toBe(0);
    await publisher.publish("auth.user.events", message);
    await publisher.publish("auth.user.events", message);
    expect(producer.connects).toBe(1);
    expect(producer.sent).toHaveLength(2);
  });

  it("retries connecting on the next publish after a failed connect", async () => {
    const { publisher, producer } = harness({ keyField: "userId" });
    producer.failConnect = true;
    await expect(
      publisher.publish("auth.user.events", message)
    ).rejects.toThrow("broker unreachable");
    expect(producer.connects).toBe(0);

    producer.failConnect = false;
    await publisher.publish("auth.user.events", message);
    expect(producer.connects).toBe(1);
    expect(producer.sent).toHaveLength(1);
  });

  it("close() disconnects a connected producer and is safe when never connected", async () => {
    const { publisher, producer } = harness({ keyField: "userId" });
    await publisher.publish("auth.user.events", message);
    await publisher.close();
    expect(producer.disconnects).toBe(1);
    await publisher.close();
    expect(producer.disconnects).toBe(1);
  });
});
