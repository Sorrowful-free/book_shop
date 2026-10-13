// DI tokens — kept out of app.module so controllers can import them
// without an import cycle.

export const AUTH_CLIENT = "AUTH_CLIENT";
export const CATALOG_CLIENT = "CATALOG_CLIENT";
export const CART_CLIENT = "CART_CLIENT";
export const ORDER_CLIENT = "ORDER_CLIENT";
export const REDIS_CLIENT = "REDIS_CLIENT";

/** Parsed COOKIE_SECURE env (boolean provider, spec §7). */
export const COOKIE_SECURE = "COOKIE_SECURE";
