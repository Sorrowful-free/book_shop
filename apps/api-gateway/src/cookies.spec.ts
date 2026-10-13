import { describe, expect, it } from "bun:test";
import type { CookieOptions, Response } from "express";
import type { authProto } from "@book-shop/contracts";
import {
  clearAuthCookies,
  clearCartCookie,
  COOKIE_NAMES,
  setAuthCookies,
  setCartCookie
} from "./cookies";

interface RecordedCall {
  method: "cookie" | "clearCookie";
  name: string;
  value?: string;
  options?: CookieOptions;
}

function fakeResponse() {
  const calls: RecordedCall[] = [];
  const res = {
    cookie(name: string, value: string, options?: CookieOptions) {
      calls.push({ method: "cookie", name, value, options });
      return res;
    },
    clearCookie(name: string, options?: CookieOptions) {
      calls.push({ method: "clearCookie", name, options });
      return res;
    }
  };
  return { res: res as unknown as Response, calls };
}

const TOKENS: authProto.AuthTokens = {
  accessToken: "access.jwt",
  refreshToken: "refresh.jwt",
  accessTokenExpiresIn: 900,
  refreshTokenExpiresIn: 2_592_000
};

describe("cookie session helpers (spec §2/§3)", () => {
  it("sets both auth cookies httpOnly, SameSite=Lax, Path=/", () => {
    const { res, calls } = fakeResponse();
    setAuthCookies(res, TOKENS, false);
    expect(calls.map((c) => c.name)).toEqual([
      COOKIE_NAMES.accessToken,
      COOKIE_NAMES.refreshToken
    ]);
    for (const call of calls) {
      expect(call.method).toBe("cookie");
      expect(call.options?.httpOnly).toBe(true);
      expect(call.options?.sameSite).toBe("lax");
      expect(call.options?.path).toBe("/");
      expect(call.options?.secure).toBe(false);
    }
    expect(calls[0].value).toBe("access.jwt");
    expect(calls[0].options?.maxAge).toBe(900_000);
    expect(calls[1].value).toBe("refresh.jwt");
    expect(calls[1].options?.maxAge).toBe(2_592_000_000);
  });

  it("honors COOKIE_SECURE on set and clear", () => {
    const { res, calls } = fakeResponse();
    setAuthCookies(res, TOKENS, true);
    clearAuthCookies(res, true);
    for (const call of calls) {
      expect(call.options?.secure).toBe(true);
    }
  });

  it("clears both auth cookies with matching path/samesite", () => {
    const { res, calls } = fakeResponse();
    clearAuthCookies(res, false);
    expect(calls.map((c) => [c.method, c.name])).toEqual([
      ["clearCookie", COOKIE_NAMES.accessToken],
      ["clearCookie", COOKIE_NAMES.refreshToken]
    ]);
    for (const call of calls) {
      expect(call.options?.httpOnly).toBe(true);
      expect(call.options?.sameSite).toBe("lax");
      expect(call.options?.path).toBe("/");
    }
  });

  it("sets the guest cart_id httpOnly without a fixed lifetime", () => {
    const { res, calls } = fakeResponse();
    setCartCookie(res, "cart-uuid", false);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.name).toBe(COOKIE_NAMES.cartId);
    expect(call.value).toBe("cart-uuid");
    expect(call.options?.httpOnly).toBe(true);
    expect(call.options?.sameSite).toBe("lax");
    expect(call.options?.maxAge).toBeUndefined();
  });

  it("clears the cart_id cookie after merge", () => {
    const { res, calls } = fakeResponse();
    clearCartCookie(res, false);
    expect(calls).toEqual([
      {
        method: "clearCookie",
        name: COOKIE_NAMES.cartId,
        value: undefined,
        options: { httpOnly: true, sameSite: "lax", path: "/", secure: false }
      }
    ]);
  });
});
