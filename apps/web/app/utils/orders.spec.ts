/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { isOrderActionable, orderStatusBadge } from "./orders";

describe("orderStatusBadge", () => {
  it("maps known statuses to label + classes", () => {
    expect(orderStatusBadge("PAID").label).toBe("Paid");
    expect(orderStatusBadge("PENDING").label).toBe("Pending");
    expect(orderStatusBadge("CANCELLED").label).toBe("Cancelled");
    expect(orderStatusBadge("PAID").classes).toContain("success");
    expect(orderStatusBadge("PENDING").classes).toContain("warning");
    expect(orderStatusBadge("CANCELLED").classes).toContain("neutral");
  });

  it("passes unknown statuses through", () => {
    const badge = orderStatusBadge("UNSPECIFIED");
    expect(badge.label).toBe("UNSPECIFIED");
    expect(badge.classes).toContain("neutral");
  });
});

describe("isOrderActionable", () => {
  it("only PENDING orders can be paid/cancelled", () => {
    expect(isOrderActionable("PENDING")).toBe(true);
    expect(isOrderActionable("PAID")).toBe(false);
    expect(isOrderActionable("CANCELLED")).toBe(false);
  });
});
