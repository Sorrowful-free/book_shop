/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  resolveAdminRedirect,
  resolveAuthRedirect,
  resolveGuestRedirect
} from "./guards";
import type { RestUser } from "./api";

const user = (role: string): RestUser => ({
  userId: "u1",
  userName: "alice",
  role
});

describe("resolveAuthRedirect", () => {
  it("sends anonymous visitors to /login", () => {
    expect(resolveAuthRedirect(null)).toBe("/login");
    expect(resolveAuthRedirect(undefined)).toBe("/login");
  });

  it("lets any session through", () => {
    expect(resolveAuthRedirect(user("CUSTOMER"))).toBeNull();
  });
});

describe("resolveAdminRedirect", () => {
  it("lets EMPLOYER and ADMIN through", () => {
    expect(resolveAdminRedirect(user("EMPLOYER"))).toBeNull();
    expect(resolveAdminRedirect(user("ADMIN"))).toBeNull();
  });

  it("redirects customers and guests to /", () => {
    expect(resolveAdminRedirect(user("CUSTOMER"))).toBe("/");
    expect(resolveAdminRedirect(null)).toBe("/");
  });
});

describe("resolveGuestRedirect", () => {
  it("sends logged-in users to /", () => {
    expect(resolveGuestRedirect(user("CUSTOMER"))).toBe("/");
  });

  it("lets anonymous visitors through", () => {
    expect(resolveGuestRedirect(null)).toBeNull();
  });
});
