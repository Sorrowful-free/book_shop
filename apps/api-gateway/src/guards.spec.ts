import { describe, expect, it, beforeAll } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import type { Request } from "express";
import {
  JwtVerifier,
  type TokenDenylist,
  type UserContext
} from "@book-shop/common";
import { UserRole } from "@book-shop/contracts";
import { AuthGuard, Roles, RolesGuard } from "./guards";

// Real JwtVerifier + generated EdDSA pair + injected denylist fake —
// covers the spec §9 unit cases: valid / expired / wrong signature /
// revoked tokens.

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: KeyPair;
let denylist: TokenDenylist & { revoked: Set<string> };
let verifier: JwtVerifier;

beforeAll(async () => {
  keys = await generateKeyPair("EdDSA", { extractable: true });
  denylist = {
    revoked: new Set<string>(),
    async isRevoked(jti: string) {
      return this.revoked.has(jti);
    }
  };
  verifier = new JwtVerifier({
    publicKey: Buffer.from(await exportSPKI(keys.publicKey)).toString("base64"),
    denylist
  });
});

async function sign(
  payload: Record<string, unknown> = {},
  expiresIn = "15m",
  jti: string = randomUUID()
): Promise<string> {
  return new SignJWT({
    role: "CUSTOMER",
    user_name: "t",
    typ: "access",
    ...payload
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject("u-1")
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(keys.privateKey);
}

function ctxWith(req: Partial<Request>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => function () {},
    getClass: () => class {}
  } as unknown as ExecutionContext;
}

function httpReq(
  headers: Record<string, string> = {},
  cookies: Record<string, string> = {}
): Partial<Request> {
  return { headers, cookies } as unknown as Request;
}

describe("AuthGuard — local JWT verify (spec §3/§9)", () => {
  it("accepts a valid Bearer token and attaches RequestAuth", async () => {
    const token = await sign({}, "15m", "jti-1");
    const req = httpReq({ authorization: `Bearer ${token}` });
    const guard = new AuthGuard(verifier);
    expect(await guard.canActivate(ctxWith(req))).toBe(true);
    const auth = (req as { auth?: { user: UserContext; accessToken: string } })
      .auth;
    expect(auth?.accessToken).toBe(token);
    expect(auth?.user.userId).toBe("u-1");
    expect(auth?.user.jti).toBe("jti-1");
  });

  it("accepts a valid token from the access_token cookie", async () => {
    const token = await sign();
    const req = httpReq({}, { access_token: token });
    expect(await new AuthGuard(verifier).canActivate(ctxWith(req))).toBe(true);
  });

  it("rejects a missing token → 401", async () => {
    await expect(
      new AuthGuard(verifier).canActivate(ctxWith(httpReq()))
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects an expired token → 401", async () => {
    const token = await sign({}, "-1s");
    const req = httpReq({ authorization: `Bearer ${token}` });
    await expect(
      new AuthGuard(verifier).canActivate(ctxWith(req))
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a token signed by another key → 401", async () => {
    const other = await generateKeyPair("EdDSA");
    const token = await new SignJWT({ role: "CUSTOMER", typ: "access" })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject("u-1")
      .setJti(randomUUID())
      .setExpirationTime("15m")
      .sign(other.privateKey);
    const req = httpReq({ authorization: `Bearer ${token}` });
    await expect(
      new AuthGuard(verifier).canActivate(ctxWith(req))
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a revoked jti (denylist) → 401", async () => {
    const jti = randomUUID();
    const token = await sign({}, "15m", jti);
    denylist.revoked.add(jti);
    const req = httpReq({ authorization: `Bearer ${token}` });
    await expect(
      new AuthGuard(verifier).canActivate(ctxWith(req))
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe("RolesGuard — spec §2 role matrix", () => {
  const guard = new RolesGuard(new Reflector());

  class BooksWrite {
    @Roles(UserRole.Employer, UserRole.Admin)
    create() {}
  }

  class NoRoles {
    read() {}
  }

  function ctx(role: UserRole | undefined, handler: unknown): ExecutionContext {
    const req = {
      auth: role ? { user: { role }, accessToken: "t" } : undefined
    };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => handler,
      getClass: () => class {}
    } as unknown as ExecutionContext;
  }

  const write = BooksWrite.prototype.create;
  const read = NoRoles.prototype.read;

  it("allows a listed role", () => {
    expect(guard.canActivate(ctx(UserRole.Employer, write))).toBe(true);
    expect(guard.canActivate(ctx(UserRole.Admin, write))).toBe(true);
  });

  it("denies an authenticated user outside the matrix → 403", () => {
    expect(() => guard.canActivate(ctx(UserRole.Customer, write))).toThrow(
      ForbiddenException
    );
  });

  it("denies an unauthenticated request on a @Roles route → 401", () => {
    expect(() => guard.canActivate(ctx(undefined, write))).toThrow(
      UnauthorizedException
    );
  });

  it("allows anything when no roles are declared", () => {
    expect(guard.canActivate(ctx(undefined, read))).toBe(true);
  });
});
