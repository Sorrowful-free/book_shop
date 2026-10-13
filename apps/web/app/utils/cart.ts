/** Pure cart view-model helpers — no nuxt imports (unit-tested by `bun test`). */

import type { EnrichedCartItem } from "./api";

/** Header badge: total number of units across all positions. */
export function cartItemCount(
  items: EnrichedCartItem[] | null | undefined
): number {
  return (items ?? []).reduce((count, item) => count + item.amount, 0);
}

/**
 * Positions whose book metadata failed enrichment carry `price: undefined`
 * (gateway degradation: `available: false`) — they contribute nothing to the
 * total instead of producing NaN.
 */
export function cartTotal(
  items: EnrichedCartItem[] | null | undefined
): number {
  return (items ?? []).reduce(
    (sum, item) =>
      typeof item.price === "number" ? sum + item.price * item.amount : sum,
    0
  );
}

/**
 * A position is problematic when the book is gone (`available === false`) or
 * the requested amount exceeds the remaining availability — such positions
 * will make checkout fail downstream, so the UI flags them.
 */
export function isCartItemProblem(item: EnrichedCartItem): boolean {
  return item.available === false || item.amount > item.available;
}
