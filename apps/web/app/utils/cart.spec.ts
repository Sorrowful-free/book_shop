/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  cartItemCount,
  cartTotal,
  isCartItemProblem,
  subtractOrderedItems
} from "./cart";
import type { EnrichedCartItem } from "./api";

const item = (over: Partial<EnrichedCartItem>): EnrichedCartItem => ({
  bookId: "b1",
  amount: 1,
  available: 10,
  ...over
});

describe("cartItemCount", () => {
  it("sums amounts across positions", () => {
    expect(
      cartItemCount([item({ amount: 2 }), item({ bookId: "b2", amount: 3 })])
    ).toBe(5);
  });

  it("handles empty/missing carts", () => {
    expect(cartItemCount([])).toBe(0);
    expect(cartItemCount(undefined)).toBe(0);
  });
});

describe("cartTotal", () => {
  it("sums price × amount", () => {
    expect(
      cartTotal([
        item({ price: 10, amount: 2 }),
        item({ bookId: "b2", price: 5, amount: 1 })
      ])
    ).toBe(25);
  });

  it("ignores unpriced (non-enriched) positions", () => {
    expect(cartTotal([item({ price: undefined, available: false })])).toBe(0);
  });
});

describe("isCartItemProblem", () => {
  it("flags positions whose book is gone", () => {
    expect(isCartItemProblem(item({ available: false }))).toBe(true);
  });

  it("flags over-available quantities", () => {
    expect(isCartItemProblem(item({ amount: 11 }))).toBe(true);
  });

  it("accepts healthy positions", () => {
    expect(isCartItemProblem(item({ amount: 10 }))).toBe(false);
  });
});

// F-W1: the badge must drop right after checkout, before the cart-service
// Kafka consumer has applied `order.order.created`.
describe("subtractOrderedItems", () => {
  it("decrements the ordered amounts", () => {
    expect(
      subtractOrderedItems(
        [item({ amount: 3 }), item({ bookId: "b2", amount: 2 })],
        [{ bookId: "b1", amount: 1 }]
      ).map((i) => i.amount)
    ).toEqual([2, 2]);
  });

  it("drops positions bought out completely", () => {
    expect(
      subtractOrderedItems([item({ amount: 2 })], [{ bookId: "b1", amount: 2 }])
    ).toEqual([]);
  });

  it("empties the cart when the order covers all of it", () => {
    expect(
      subtractOrderedItems(
        [item({ amount: 1 }), item({ bookId: "b2", amount: 4 })],
        [
          { bookId: "b1", amount: 1 },
          { bookId: "b2", amount: 4 }
        ]
      )
    ).toEqual([]);
  });

  it("ignores order positions absent from the cart", () => {
    expect(
      subtractOrderedItems(
        [item({ amount: 1 })],
        [{ bookId: "gone", amount: 9 }]
      )
    ).toEqual([item({ amount: 1 })]);
  });
});
