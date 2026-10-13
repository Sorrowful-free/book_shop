/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { isBookPurchasable, pageCount, parsePage } from "./books";

describe("isBookPurchasable", () => {
  it("requires non-deleted and positive availability", () => {
    expect(isBookPurchasable({ isDeleted: false, available: 3 })).toBe(true);
    expect(isBookPurchasable({ isDeleted: true, available: 3 })).toBe(false);
    expect(isBookPurchasable({ isDeleted: false, available: 0 })).toBe(false);
    expect(isBookPurchasable({ isDeleted: true, available: 0 })).toBe(false);
  });
});

describe("pageCount", () => {
  it("computes ceil(total/limit) with a floor of 1", () => {
    expect(pageCount(0, 12)).toBe(1);
    expect(pageCount(12, 12)).toBe(1);
    expect(pageCount(13, 12)).toBe(2);
    expect(pageCount(24, 12)).toBe(2);
    expect(pageCount(25, 12)).toBe(3);
  });
});

describe("parsePage", () => {
  it("parses positive ints", () => {
    expect(parsePage("3")).toBe(3);
    expect(parsePage(2)).toBe(2);
  });

  it("falls back to 1 for garbage", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-4")).toBe(1);
    expect(parsePage(["a", "b"])).toBe(1);
  });
});
