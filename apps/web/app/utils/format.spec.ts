/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { formatPrice } from "./format";

describe("formatPrice", () => {
  it("formats USD prices", () => {
    expect(formatPrice(12)).toBe("$12.00");
    expect(formatPrice(9.99)).toBe("$9.99");
    expect(formatPrice(0)).toBe("$0.00");
    expect(formatPrice(1234.5)).toBe("$1,234.50");
  });

  it("renders missing/garbage values as an em dash", () => {
    expect(formatPrice(undefined)).toBe("—");
    expect(formatPrice(null)).toBe("—");
    expect(formatPrice(Number.NaN)).toBe("—");
  });
});
