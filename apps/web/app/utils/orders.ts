/** Pure order view-model helpers — no nuxt imports (unit-tested by `bun test`). */

export interface StatusBadge {
  label: string;
  classes: string;
}

/** Order status → badge label + tailwind classes for the /orders table. */
export function orderStatusBadge(status: string): StatusBadge {
  switch (status) {
    case "PAID":
      return { label: "Paid", classes: "bg-green-100 text-green-800" };
    case "PENDING":
      return { label: "Pending", classes: "bg-amber-100 text-amber-800" };
    case "CANCELLED":
      return { label: "Cancelled", classes: "bg-gray-200 text-gray-600" };
    default:
      return { label: status, classes: "bg-gray-100 text-gray-700" };
  }
}

/** Only PENDING orders expose pay/cancel actions. */
export function isOrderActionable(status: string): boolean {
  return status === "PENDING";
}
