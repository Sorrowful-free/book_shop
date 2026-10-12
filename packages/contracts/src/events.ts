import { KAFKA_TOPICS } from "./topics";
import { UserRole } from "./types";

export const EVENT_TYPES = {
  userRegistered: "auth.user.registered",
  bookCreated: "catalog.book.created",
  bookUpdated: "catalog.book.updated",
  bookDeleted: "catalog.book.deleted",
  orderCreated: "order.order.created",
  orderPaid: "order.order.paid",
  orderCancelled: "order.order.cancelled"
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export interface DomainEvent<TPayload, TType extends EventType = EventType> {
  eventId: string;
  eventType: TType;
  occurredAt: string;
  payload: TPayload;
}

export interface UserRegisteredPayload {
  userId: string;
  userName: string;
  role: UserRole;
}

export interface BookCreatedPayload {
  bookId: string;
  bookName: string;
  author: string;
  price: number;
}

export interface BookUpdatedPayload {
  bookId: string;
  bookName: string;
  author: string;
  price: number;
}

export interface BookDeletedPayload {
  bookId: string;
}

export interface OrderGoodsItem {
  bookId: string;
  bookName: string;
  author: string;
  price: number;
  amount: number;
}

export interface OrderCreatedPayload {
  orderId: string;
  userId: string;
  goods: OrderGoodsItem[];
  totalPrice: number;
}

export interface OrderPaidPayload {
  orderId: string;
  userId: string;
  totalPrice: number;
}

export interface OrderCancelledPayload {
  orderId: string;
  userId: string;
}

export type UserRegisteredEvent = DomainEvent<
  UserRegisteredPayload,
  typeof EVENT_TYPES.userRegistered
>;
export type BookCreatedEvent = DomainEvent<
  BookCreatedPayload,
  typeof EVENT_TYPES.bookCreated
>;
export type BookUpdatedEvent = DomainEvent<
  BookUpdatedPayload,
  typeof EVENT_TYPES.bookUpdated
>;
export type BookDeletedEvent = DomainEvent<
  BookDeletedPayload,
  typeof EVENT_TYPES.bookDeleted
>;
export type OrderCreatedEvent = DomainEvent<
  OrderCreatedPayload,
  typeof EVENT_TYPES.orderCreated
>;
export type OrderPaidEvent = DomainEvent<
  OrderPaidPayload,
  typeof EVENT_TYPES.orderPaid
>;
export type OrderCancelledEvent = DomainEvent<
  OrderCancelledPayload,
  typeof EVENT_TYPES.orderCancelled
>;

export const EVENT_TYPE_TO_TOPIC = {
  [EVENT_TYPES.userRegistered]: KAFKA_TOPICS.authUserEvents,
  [EVENT_TYPES.bookCreated]: KAFKA_TOPICS.catalogBookEvents,
  [EVENT_TYPES.bookUpdated]: KAFKA_TOPICS.catalogBookEvents,
  [EVENT_TYPES.bookDeleted]: KAFKA_TOPICS.catalogBookEvents,
  [EVENT_TYPES.orderCreated]: KAFKA_TOPICS.orderOrderEvents,
  [EVENT_TYPES.orderPaid]: KAFKA_TOPICS.orderOrderEvents,
  [EVENT_TYPES.orderCancelled]: KAFKA_TOPICS.orderOrderEvents
} as const;
