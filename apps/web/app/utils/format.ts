/** Pure display helpers — keep this file free of nuxt imports so `bun test` can load it raw. */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
});

/** `$12.34`-style price; a missing/garbage value renders as an em dash. */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return USD.format(value);
}
