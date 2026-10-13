/**
 * Route-middleware decisions as pure functions (unit-tested by `bun test`).
 * The middleware wrappers in `app/middleware/` are thin `navigateTo` shells
 * around these.
 */

import type { RestUser } from "./api";

/** Staff roles allowed into /admin/*; mirrors the gateway role matrix (spec 05 §2). */
export const STAFF_ROLES = ["ADMIN", "EMPLOYER"] as const;

/** `auth` middleware: unauthenticated → /login. */
export function resolveAuthRedirect(
  user: RestUser | null | undefined
): string | null {
  return user ? null : "/login";
}

/** `admin` middleware: anyone but EMPLOYER/ADMIN → /. */
export function resolveAdminRedirect(
  user: RestUser | null | undefined
): string | null {
  if (user && (STAFF_ROLES as readonly string[]).includes(user.role)) {
    return null;
  }
  return "/";
}

/** `guest` middleware (login/register): already logged in → /. */
export function resolveGuestRedirect(
  user: RestUser | null | undefined
): string | null {
  return user ? "/" : null;
}
