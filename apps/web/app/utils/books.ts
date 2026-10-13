/** Pure book/pagination view-model helpers — no nuxt imports. */

import type { RestBook } from "./api";

/**
 * A book can be added to the cart only while it is not soft-deleted and has
 * remaining availability. Deleted/zero-stock books still render on the
 * storefront (with an "Unavailable" badge) — the button is disabled.
 */
export function isBookPurchasable(
  book: Pick<RestBook, "isDeleted" | "available">
): boolean {
  return !book.isDeleted && book.available > 0;
}

/** Number of pages for a `?page=` pager; always ≥ 1 so page math is safe. */
export function pageCount(total: number, limit: number): number {
  if (limit <= 0 || total <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(total / limit));
}

/** 1-based `?page` query param → safe positive integer. */
export function parsePage(raw: unknown): number {
  const parsed = Number.parseInt(String(raw ?? "1"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}
