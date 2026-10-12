import { describe, expect, it } from "bun:test";
import { KAFKA_TOPICS } from "@book-shop/contracts";
import {
  OutboxRelay,
  type EventPublisher,
  type OutboxRow,
  type OutboxStore
} from "./outbox-relay";

function harness(rows: OutboxRow[]) {
  const published: Array<{ topic: string; message: unknown }> = [];
  const marked: string[] = [];
  const errors: unknown[] = [];
  const store: OutboxStore = {
    fetchUnpublished: async () => rows,
    markPublished: async (ids) => {
      marked.push(...ids);
    }
  };
  const publisher: EventPublisher = {
    publish: async (topic, message) => {
      published.push({ topic, message });
    }
  };
  const relay = new OutboxRelay(store, publisher, {
    onError: (e) => errors.push(e)
  });
  return { relay, published, marked, errors };
}

describe("OutboxRelay", () => {
  it("publishes known events to resolved topics and marks them", async () => {
    const { relay, published, marked } = harness([
      { id: "1", eventType: "order.order.created", payload: { orderId: "o1" } },
      { id: "2", eventType: "auth.user.registered", payload: { userId: "u1" } }
    ]);
    expect(await relay.tick()).toBe(2);
    expect(published.map((p) => p.topic)).toEqual([
      KAFKA_TOPICS.orderOrderEvents,
      KAFKA_TOPICS.authUserEvents
    ]);
    expect(marked).toEqual(["1", "2"]);
  });

  it("dead-letters unknown eventTypes (marked + onError)", async () => {
    const { relay, published, marked, errors } = harness([
      { id: "1", eventType: "bogus.event", payload: {} },
      { id: "2", eventType: "order.order.paid", payload: {} }
    ]);
    await relay.tick();
    expect(errors).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(marked).toEqual(["1", "2"]);
  });

  it("does not mark a row when publish fails (at-least-once)", async () => {
    const rows = [{ id: "1", eventType: "order.order.created", payload: {} }];
    const marked: string[] = [];
    const store: OutboxStore = {
      fetchUnpublished: async () => rows,
      markPublished: async (ids) => {
        marked.push(...ids);
      }
    };
    const relay = new OutboxRelay(store, {
      publish: async () => {
        throw new Error("broker down");
      }
    });
    await expect(relay.tick()).rejects.toThrow("broker down");
    expect(marked).toEqual([]);
  });
});
