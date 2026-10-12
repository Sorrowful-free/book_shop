import { describe, expect, it } from "bun:test";
import { EVENT_TYPES, EVENT_TYPE_TO_TOPIC, KAFKA_TOPICS } from "./index";

describe("contracts", () => {
  it("maps every event type to a known kafka topic", () => {
    const topics = new Set<string>(Object.values(KAFKA_TOPICS));
    for (const eventType of Object.values(EVENT_TYPES)) {
      expect(topics.has(EVENT_TYPE_TO_TOPIC[eventType])).toBe(true);
    }
  });

  it("uses <domain>.<aggregate>.events topic naming", () => {
    for (const topic of Object.values(KAFKA_TOPICS)) {
      expect(topic).toMatch(/^[a-z]+\.[a-z]+\.events$/);
    }
  });
});
