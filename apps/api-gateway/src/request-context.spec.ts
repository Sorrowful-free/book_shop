import { describe, expect, it } from "bun:test";
import type { Request } from "express";
import type { JwtVerifier, UserContext } from "@book-shop/common";
import { UserRole } from "@book-shop/contracts";
import {
  authenticate,
  extractAccessToken,
  extractCartId,
  extractRefreshToken,
  outgoingMetadata,
  resolveCartOwner
} from "./request-context";

function req(
  headers: Record<string, string> = {},
  cookies: Record<string, string> = {},
  body: unknown = undefined
): Request {
  return { headers, cookies, body } as unknown as Request;
}

describe("credential extraction (spec §3)", () => {
  it("reads the access token from the Bearer header", () => {
    expect(extractAccessToken(req({ authorization: "Bearer tok-1" }))).toBe(
      "tok-1"
    );
  });

  it("reads the access token from the access_token cookie", () => {
    expect(extractAccessToken(req({}, { access_token: "cookie-tok" }))).toBe(
      "cookie-tok"
    );
  });

  it("prefers an explicit Bearer header over the cookie", () => {
    expect(
      extractAccessToken(
        req({ authorization: "Bearer header-tok" }, { access_token: "c" })
      )
    ).toBe("header-tok");
  });

  it("ignores malformed or empty credentials", () => {
    expect(extractAccessToken(req())).toBeUndefined();
    expect(
      extractAccessToken(req({ authorization: "Basic abc" }))
    ).toBeUndefined();
    expect(
      extractAccessToken(req({ authorization: "Bearer " }))
    ).toBeUndefined();
    expect(extractAccessToken(req({}, { access_token: "" }))).toBeUndefined();
  });

  it("reads the refresh token from the body or the cookie", () => {
    const withBody = req(
      {},
      { refresh_token: "cookie-rt" },
      {
        refreshToken: "body-rt"
      }
    );
    expect(extractRefreshToken(withBody, { refreshToken: "body-rt" })).toBe(
      "body-rt"
    );
    const cookieOnly = req({}, { refresh_token: "cookie-rt" });
    expect(extractRefreshToken(cookieOnly)).toBe("cookie-rt");
    expect(extractRefreshToken(req())).toBeUndefined();
  });

  it("reads the guest cart_id cookie", () => {
    expect(extractCartId(req({}, { cart_id: "cart-1" }))).toBe("cart-1");
    expect(extractCartId(req())).toBeUndefined();
    expect(extractCartId(req({}, { cart_id: "" }))).toBeUndefined();
  });
});

describe("outgoing gRPC metadata (spec §3)", () => {
  it("forwards the raw JWT as authorization, never x-user-*", () => {
    const metadata = outgoingMetadata(
      req({ "x-user-id": "spoof" }),
      "jwt-token"
    );
    expect(metadata.get("authorization")).toEqual(["Bearer jwt-token"]);
    // x-user-* headers are never propagated downstream
    expect(metadata.get("x-user-id")).toEqual([]);
    expect(metadata.getMap()["x-user-id"]).toBeUndefined();
  });

  it("propagates an incoming x-trace-id", () => {
    const metadata = outgoingMetadata(req({ "x-trace-id": "trace-42" }));
    expect(metadata.get("x-trace-id")).toEqual(["trace-42"]);
  });

  it("generates a trace id when the header is absent", () => {
    const metadata = outgoingMetadata(req());
    const [value] = metadata.get("x-trace-id");
    expect(String(value)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("sends no authorization metadata for anonymous calls", () => {
    const metadata = outgoingMetadata(req());
    expect(metadata.get("authorization")).toEqual([]);
  });
});

describe("cart owner resolution (spec §2)", () => {
  const user: UserContext = {
    userId: "u-1",
    userName: "alice",
    role: UserRole.Customer
  };
  const verifierFor = (result: UserContext | null) =>
    ({ verify: async () => result }) as unknown as JwtVerifier;

  it("a verified JWT selects user mode — cart_id cookie is ignored", async () => {
    const owner = await resolveCartOwner(
      verifierFor(user),
      req({ authorization: "Bearer good" }, { cart_id: "guest-cart" })
    );
    expect(owner.kind).toBe("user");
    if (owner.kind === "user") {
      expect(owner.auth.user).toBe(user);
      expect(owner.metadata.get("authorization")).toEqual(["Bearer good"]);
    }
    expect("cartId" in owner ? owner.cartId : undefined).toBeUndefined();
  });

  it("an invalid/absent JWT falls back to guest mode with the cookie", async () => {
    const owner = await resolveCartOwner(
      verifierFor(null),
      req({ authorization: "Bearer bad" }, { cart_id: "guest-cart" })
    );
    expect(owner).toMatchObject({ kind: "guest", cartId: "guest-cart" });
    expect(owner.metadata.get("authorization")).toEqual([]);
  });

  it("a guest without a cookie resolves with no cartId", async () => {
    const owner = await resolveCartOwner(verifierFor(null), req());
    expect(owner).toMatchObject({ kind: "guest", cartId: undefined });
  });

  it("authenticate() returns the verified context or null", async () => {
    const auth = await authenticate(
      verifierFor(user),
      req({}, { access_token: "tok" })
    );
    expect(auth).toEqual({ user, accessToken: "tok" });
    expect(await authenticate(verifierFor(null), req())).toBeNull();
    expect(
      await authenticate(verifierFor(null), req({}, { access_token: "x" }))
    ).toBeNull();
  });
});
