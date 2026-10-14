/** Pure order view-model helpers — no nuxt imports (unit-tested by `bun test`). */

export interface StatusBadge {
  label: string;
  classes: string;
}

/** Order status → badge label + semantic badge variant for /orders. */
export function orderStatusBadge(status: string): StatusBadge {
  switch (status) {
    case "PAID":
      return { label: "Paid", classes: "badge-success" };
    case "PENDING":
      return { label: "Pending", classes: "badge-warning" };
    case "CANCELLED":
      return { label: "Cancelled", classes: "badge-neutral" };
    default:
      return { label: status, classes: "badge-neutral" };
  }
}

/** Only PENDING orders expose pay/cancel actions. */
export function isOrderActionable(status: string): boolean {
  return status === "PENDING";
}
