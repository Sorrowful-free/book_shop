/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { cartItemCount, cartTotal, isCartItemProblem } from "./cart";
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
