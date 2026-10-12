export const KAFKA_TOPICS = {
  authUserEvents: "auth.user.events",
  catalogBookEvents: "catalog.book.events",
  orderOrderEvents: "order.order.events"
} as const;

export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];
