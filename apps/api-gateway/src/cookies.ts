// Cookie session management (spec §2/§3): `access_token` + `refresh_token`
// hold the JWT pair (httpOnly — never readable from JS), `cart_id` keeps the
// guest cart handle. All three are SameSite=Lax, Path=/, Secure behind the
// COOKIE_SECURE env (prod only — spec §7/§10).

import type { CookieOptions, Response } from "express";
import type { authProto } from "@book-shop/contracts";

export const COOKIE_NAMES = {
  accessToken: "access_token",
  refreshToken: "refresh_token",
  cartId: "cart_id"
} as const;

export function baseCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: "lax", path: "/", secure };
}

/** Login/register/refresh: both tokens are (re)written together. */
export function setAuthCookies(
  res: Response,
  tokens: authProto.AuthTokens,
  secure: boolean
): void {
  const options = baseCookieOptions(secure);
  res.cookie(COOKIE_NAMES.accessToken, tokens.accessToken, {
    ...options,
    maxAge: tokens.accessTokenExpiresIn * 1000
  });
  res.cookie(COOKIE_NAMES.refreshToken, tokens.refreshToken, {
    ...options,
    maxAge: tokens.refreshTokenExpiresIn * 1000
  });
}

/** Logout always clears the auth pair (spec §2 — even when revoke fails). */
export function clearAuthCookies(res: Response, secure: boolean): void {
  const options = baseCookieOptions(secure);
  res.clearCookie(COOKIE_NAMES.accessToken, options);
  res.clearCookie(COOKIE_NAMES.refreshToken, options);
}

/**
 * Guest cart handle. No maxAge — a session cookie: the cart itself already
 * expires server-side (Redis sliding TTL), pinning a second lifetime here
 * would just drift from it.
 */
export function setCartCookie(
  res: Response,
  cartId: string,
  secure: boolean
): void {
  res.cookie(COOKIE_NAMES.cartId, cartId, baseCookieOptions(secure));
}

/** Cleared once the guest cart has been merged into the user cart. */
export function clearCartCookie(res: Response, secure: boolean): void {
  res.clearCookie(COOKIE_NAMES.cartId, baseCookieOptions(secure));
}
