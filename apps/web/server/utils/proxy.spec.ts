/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  hasCookie,
  mapProxyPath,
  mergeCookies,
  relayResponseHeaders,
  responseCookies,
  shouldAttemptRefresh
} from "./proxy";

describe("mapProxyPath", () => {
  it("maps /api/* onto {GATEWAY_URL}/api/v1/*", () => {
    expect(mapProxyPath("http://localhost:3000", "/api/books")).toBe(
      "http://localhost:3000/api/v1/books"
    );
  });

  it("preserves the query string", () => {
    expect(
      mapProxyPath("http://gw:3000", "/api/books", "?limit=12&genre=tech")
    ).toBe("http://gw:3000/api/v1/books?limit=12&genre=tech");
  });

  it("strips a trailing slash on the gateway base", () => {
    expect(mapProxyPath("http://gw:3000/", "/api/cart")).toBe(
      "http://gw:3000/api/v1/cart"
    );
  });

  it("passes an already-versioned /api/v1/* path through unchanged", () => {
    // backend-issued cover URLs reach the BFF as /api/v1/covers/<key>
    // (spec 08 §6) — a second v1 prefix must not be stacked on.
    expect(
      mapProxyPath(
        "http://localhost:3000",
        "/api/v1/covers/2f7a3c1e-9b0d-4e5f-8a6b-7c8d9e0f1a2b.png"
      )
    ).toBe(
      "http://localhost:3000/api/v1/covers/2f7a3c1e-9b0d-4e5f-8a6b-7c8d9e0f1a2b.png"
    );
  });

  it("keeps prefixing non-versioned /api/* paths", () => {
    expect(mapProxyPath("http://gw:3000", "/api/covers/upload")).toBe(
      "http://gw:3000/api/v1/covers/upload"
    );
    expect(mapProxyPath("http://gw:3000", "/api/v10/covers/x")).toBe(
      "http://gw:3000/api/v1/v10/covers/x"
    );
  });
});

describe("hasCookie", () => {
  it("finds a cookie in a header list", () => {
    expect(
      hasCookie("access_token=a; refresh_token=r; cart_id=c", "refresh_token")
    ).toBe(true);
  });

  it("returns false for missing cookie / missing header", () => {
    expect(hasCookie("access_token=a", "refresh_token")).toBe(false);
    expect(hasCookie(undefined, "refresh_token")).toBe(false);
    expect(hasCookie("", "refresh_token")).toBe(false);
  });
});

describe("shouldAttemptRefresh", () => {
  const cookie = "access_token=old; refresh_token=r";

  it("attempts refresh on 401 when a refresh_token cookie exists", () => {
    expect(shouldAttemptRefresh(401, cookie, "/api/orders")).toBe(true);
  });

  it("does not refresh non-401 responses", () => {
    expect(shouldAttemptRefresh(200, cookie, "/api/orders")).toBe(false);
    expect(shouldAttemptRefresh(403, cookie, "/api/admin")).toBe(false);
  });

  it("does not refresh without a refresh_token cookie", () => {
    expect(shouldAttemptRefresh(401, "access_token=old", "/api/orders")).toBe(
      false
    );
    expect(shouldAttemptRefresh(401, undefined, "/api/orders")).toBe(false);
  });

  it("never nests a refresh inside a refresh call", () => {
    expect(shouldAttemptRefresh(401, cookie, "/api/auth/refresh")).toBe(false);
  });
});

describe("responseCookies", () => {
  it("reads multiple set-cookie headers off a Response", () => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    expect(responseCookies({ headers })).toEqual([
      "a=1; Path=/",
      "b=2; Path=/"
    ]);
  });

  it("splits a merged set-cookie header without breaking Expires=", () => {
    const merged =
      "access_token=x; Expires=Wed, 21 Oct 2030 00:00:00 GMT; Path=/, refresh_token=y; Path=/";
    const res = {
      headers: { get: (k: string) => (k === "set-cookie" ? merged : null) }
    };
    expect(responseCookies(res as never)).toEqual([
      "access_token=x; Expires=Wed, 21 Oct 2030 00:00:00 GMT; Path=/",
      "refresh_token=y; Path=/"
    ]);
  });

  it("returns [] when the response carries no cookies", () => {
    expect(responseCookies({ headers: new Headers() })).toEqual([]);
  });
});

describe("relayResponseHeaders", () => {
  it("relays content-type, content-length and cache-control verbatim", () => {
    // spec 08 §5/§10: the immutable Cache-Control on GET /covers/:key must
    // survive the BFF — a header dropped here silently uncaches covers.
    const headers = new Headers({
      "content-type": "image/png",
      "content-length": "11",
      "cache-control": "public, max-age=31536000, immutable",
      "x-internal": "not-relayed"
    });
    expect(relayResponseHeaders({ headers })).toEqual([
      ["content-type", "image/png"],
      ["content-length", "11"],
      ["cache-control", "public, max-age=31536000, immutable"]
    ]);
  });

  it("omits headers the upstream response does not carry", () => {
    const headers = new Headers({ "content-type": "application/json" });
    expect(relayResponseHeaders({ headers })).toEqual([
      ["content-type", "application/json"]
    ]);
  });
});

describe("mergeCookies", () => {
  it("overrides existing names and keeps untouched cookies", () => {
    const merged = mergeCookies(
      "access_token=old; refresh_token=r1; cart_id=c",
      [
        "access_token=new; Path=/; HttpOnly",
        "refresh_token=r2; Path=/; HttpOnly"
      ]
    );
    expect(merged).toBe("access_token=new; refresh_token=r2; cart_id=c");
  });

  it("adds cookies absent from the original header", () => {
    expect(mergeCookies(undefined, ["cart_id=c1; Path=/"])).toBe("cart_id=c1");
  });

  it("drops cookies that are being cleared", () => {
    expect(
      mergeCookies("access_token=a; refresh_token=r", [
        "access_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
      ])
    ).toBe("refresh_token=r");
  });
});
