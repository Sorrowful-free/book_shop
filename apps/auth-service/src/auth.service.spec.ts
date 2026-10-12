import { describe, expect, it } from "bun:test";
import { status } from "@grpc/grpc-js";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { JwtVerifier, type TokenDenylist } from "@book-shop/common";
import { EVENT_TYPES, UserRole } from "@book-shop/contracts";
import { AuthService } from "./auth.service";
import type { TokenDenylistWriter } from "./denylist";
import type {
  AuthRepository,
  NewRefreshToken,
  NewUser,
  OutboxEventInput,
  RefreshTokenRecord,
  UserRecord
} from "./repository";
import { TokenService } from "./tokens";

const PASSWORD = "Str0ng!pass";
const USERNAME = "alice_01";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class InMemoryAuthRepository implements AuthRepository {
  usersById = new Map<string, UserRecord>();
  refreshTokens = new Map<string, RefreshTokenRecord>();
  outbox: OutboxEventInput[] = [];
  userSeq = 0;

  async findUserByName(userName: string): Promise<UserRecord | null> {
    return (
      [...this.usersById.values()].find((u) => u.userName === userName) ?? null
    );
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    return this.usersById.get(id) ?? null;
  }

  async createUserWithOutbox(
    user: NewUser,
    buildEvent: (created: UserRecord) => OutboxEventInput
  ): Promise<UserRecord> {
    const created: UserRecord = {
      id: `user-${++this.userSeq}`,
      createdAt: new Date(),
      ...user
    };
    // user + outbox row in ONE transaction — single repository call
    this.usersById.set(created.id, created);
    this.outbox.push(buildEvent(created));
    return created;
  }

  async findRefreshToken(jti: string): Promise<RefreshTokenRecord | null> {
    return this.refreshTokens.get(jti) ?? null;
  }

  async createRefreshToken(row: NewRefreshToken): Promise<void> {
    this.refreshTokens.set(row.id, {
      ...row,
      revokedAt: null,
      createdAt: new Date()
    });
  }

  // mirrors the prisma adapter's atomic `WHERE revoked_at IS NULL` update
  async revokeRefreshToken(jti: string, revokedAt: Date): Promise<number> {
    const row = this.refreshTokens.get(jti);
    if (!row || row.revokedAt !== null) {
      return 0;
    }
    row.revokedAt = revokedAt;
    return 1;
  }

  // mirrors the prisma adapter's `expires_at < cutoff` deleteMany (F-A1)
  async deleteExpiredRefreshTokens(cutoff: Date): Promise<number> {
    let count = 0;
    for (const [jti, row] of this.refreshTokens) {
      if (row.expiresAt < cutoff) {
        this.refreshTokens.delete(jti);
        count++;
      }
    }
    return count;
  }
}

class FakeDenylistWriter implements TokenDenylistWriter, TokenDenylist {
  entries = new Map<string, number>();

  async revoke(jti: string, ttlSeconds: number): Promise<void> {
    this.entries.set(jti, ttlSeconds);
  }

  async isRevoked(jti: string): Promise<boolean> {
    return this.entries.has(jti);
  }
}

async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    extractable: true
  });
  return {
    privateKeyB64: Buffer.from(await exportPKCS8(privateKey), "utf8").toString(
      "base64"
    ),
    publicKeyB64: Buffer.from(await exportSPKI(publicKey), "utf8").toString(
      "base64"
    )
  };
}

async function harness(options?: {
  accessTtlSec?: number;
  refreshTtlSec?: number;
}) {
  const keys = await makeKeys();
  const repository = new InMemoryAuthRepository();
  const tokens = new TokenService({
    privateKey: keys.privateKeyB64,
    accessTtlSec: options?.accessTtlSec ?? 3600,
    refreshTtlSec: options?.refreshTtlSec ?? 86400
  });
  const denylist = new FakeDenylistWriter();
  const verifier = new JwtVerifier({
    publicKey: keys.publicKeyB64,
    denylist
  });
  const service = new AuthService({ repository, tokens, denylist, verifier });
  return { service, repository, tokens, denylist, verifier };
}

function grpcCode(error: unknown): number | undefined {
  const err = error as any;
  return err?.code ?? err?.error?.code ?? err?.getError?.()?.code;
}

async function expectGrpcError(
  promise: Promise<unknown>,
  expected: status
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(grpcCode(error)).toBe(expected);
    return;
  }
  expect.unreachable(`expected gRPC error ${status[expected]}`);
}

describe("AuthService.register", () => {
  it("creates a CUSTOMER, stores an argon2 hash and writes user+outbox in one transaction", async () => {
    const { service, repository } = await harness();

    const tokens = await service.register({
      userName: USERNAME,
      password: PASSWORD
    });
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.accessTokenExpiresIn).toBeGreaterThan(0);
    expect(tokens.refreshTokenExpiresIn).toBeGreaterThan(0);

    const user = await repository.findUserByName(USERNAME);
    expect(user).not.toBeNull();
    expect(user!.role).toBe(UserRole.Customer);
    expect(user!.passwordHash.startsWith("$argon2")).toBe(true);
    expect(user!.passwordHash).not.toContain(PASSWORD);

    expect(repository.outbox).toHaveLength(1);
    expect(repository.outbox[0].eventType).toBe(EVENT_TYPES.userRegistered);
    expect(repository.outbox[0].payload).toMatchObject({
      userId: user!.id,
      userName: USERNAME,
      role: UserRole.Customer
    });
  });

  it("rejects a taken user_name with ALREADY_EXISTS", async () => {
    const { service } = await harness();
    await service.register({ userName: USERNAME, password: PASSWORD });
    await expectGrpcError(
      service.register({ userName: USERNAME, password: PASSWORD }),
      status.ALREADY_EXISTS
    );
  });

  it.each(["short1!", "allletters!", "1234567!", "nodigitspecial"])(
    "rejects a weak password %j with INVALID_ARGUMENT",
    async (password) => {
      const { service, repository } = await harness();
      await expectGrpcError(
        service.register({ userName: USERNAME, password }),
        status.INVALID_ARGUMENT
      );
      expect(repository.usersById.size).toBe(0);
      expect(repository.outbox).toHaveLength(0);
    }
  );

  it.each(["ab", "a".repeat(33), "bad name", "bad-name", "bad.name"])(
    "rejects invalid user_name %j with INVALID_ARGUMENT",
    async (userName) => {
      const { service, repository } = await harness();
      await expectGrpcError(
        service.register({ userName, password: PASSWORD }),
        status.INVALID_ARGUMENT
      );
      expect(repository.usersById.size).toBe(0);
    }
  );
});

describe("AuthService.login", () => {
  it("returns a token pair for valid credentials", async () => {
    const { service, repository } = await harness();
    await service.register({ userName: USERNAME, password: PASSWORD });

    const tokens = await service.login({
      userName: USERNAME,
      password: PASSWORD
    });
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    // a refresh token row (jti) is persisted
    expect(repository.refreshTokens.size).toBeGreaterThan(0);
  });

  it("rejects a wrong password with UNAUTHENTICATED", async () => {
    const { service } = await harness();
    await service.register({ userName: USERNAME, password: PASSWORD });
    await expectGrpcError(
      service.login({ userName: USERNAME, password: "Wrong!234" }),
      status.UNAUTHENTICATED
    );
  });

  it("rejects an unknown user with UNAUTHENTICATED (no oracle)", async () => {
    const { service } = await harness();
    await expectGrpcError(
      service.login({ userName: "no_such_user", password: PASSWORD }),
      status.UNAUTHENTICATED
    );
  });
});

describe("AuthService.refresh — jti rotation", () => {
  it("rotates: new pair issued, old jti marked revoked, reuse rejected", async () => {
    const { service, repository } = await harness();
    const first = await service.register({
      userName: USERNAME,
      password: PASSWORD
    });

    const second = await service.refresh({
      refreshToken: first.refreshToken
    });
    expect(second.accessToken).toBeTruthy();
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // old jti revoked in DB (kept for audit, not deleted)
    const revoked = [...repository.refreshTokens.values()].find(
      (t) => t.revokedAt !== null
    );
    expect(revoked).toBeDefined();

    // reuse of the rotated token is rejected
    await expectGrpcError(
      service.refresh({ refreshToken: first.refreshToken }),
      status.UNAUTHENTICATED
    );
  });

  it("lets only one of two concurrent refreshes succeed (atomic rotation)", async () => {
    const { service } = await harness();
    const first = await service.register({
      userName: USERNAME,
      password: PASSWORD
    });

    const results = await Promise.allSettled([
      service.refresh({ refreshToken: first.refreshToken }),
      service.refresh({ refreshToken: first.refreshToken })
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(grpcCode((rejected[0] as PromiseRejectedResult).reason)).toBe(
      status.UNAUTHENTICATED
    );
  });

  it("rejects an access token presented to the Refresh RPC (typ claim)", async () => {
    const { service } = await harness();
    const pair = await service.register({
      userName: USERNAME,
      password: PASSWORD
    });
    await expectGrpcError(
      service.refresh({ refreshToken: pair.accessToken }),
      status.UNAUTHENTICATED
    );
  });

  it("rejects a forged refresh token signature", async () => {
    const { service } = await harness();
    const other = await harness();
    const foreign = await other.service.register({
      userName: "bob_01",
      password: PASSWORD
    });
    await expectGrpcError(
      service.refresh({ refreshToken: foreign.refreshToken }),
      status.UNAUTHENTICATED
    );
  });

  it("rejects an expired refresh token (TTL=1s, real wait)", async () => {
    const { service } = await harness({ refreshTtlSec: 1 });
    const first = await service.register({
      userName: USERNAME,
      password: PASSWORD
    });
    await sleep(1100);
    await expectGrpcError(
      service.refresh({ refreshToken: first.refreshToken }),
      status.UNAUTHENTICATED
    );
  }, 10_000);
});

describe("AuthService.revokeToken", () => {
  it("marks the refresh jti revoked and is idempotent", async () => {
    const { service, repository } = await harness();
    const tokens = await service.register({
      userName: USERNAME,
      password: PASSWORD
    });

    await service.revokeToken({ refreshToken: tokens.refreshToken });
    const row = [...repository.refreshTokens.values()][0];
    expect(row.revokedAt).not.toBeNull();

    // idempotent: second revoke of the same token succeeds
    await service.revokeToken({ refreshToken: tokens.refreshToken });
  });

  it("puts the access jti into the denylist with TTL = exp - now", async () => {
    const { service, tokens, denylist, verifier } = await harness();
    const pair = await service.register({
      userName: USERNAME,
      password: PASSWORD
    });
    const { jti } = (await tokens.verifyAccessSignatureOnly(pair.accessToken))!;

    // access verifies fine before revoke
    expect(await verifier.verify(pair.accessToken)).not.toBeNull();

    await service.revokeToken({
      refreshToken: pair.refreshToken,
      accessToken: pair.accessToken
    });

    expect(denylist.entries.has(jti)).toBe(true);
    const ttl = denylist.entries.get(jti)!;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3600);

    // the revoked access no longer verifies (denylist checked by JwtVerifier)
    expect(await verifier.verify(pair.accessToken)).toBeNull();
  });

  it("skips the denylist write for an expired-but-signed access token", async () => {
    const { service, denylist } = await harness({ accessTtlSec: 1 });
    const pair = await service.register({
      userName: USERNAME,
      password: PASSWORD
    });
    await sleep(1100);
    // access expired (TTL <= 0 remaining) — revoke is a success but nothing
    // is written to the denylist
    await service.revokeToken({
      refreshToken: pair.refreshToken,
      accessToken: pair.accessToken
    });
    expect(denylist.entries.size).toBe(0);
  }, 10_000);

  it("rejects a forged refresh token", async () => {
    const { service } = await harness();
    const other = await harness();
    const foreign = await other.service.register({
      userName: "carol_1",
      password: PASSWORD
    });
    await expectGrpcError(
      service.revokeToken({ refreshToken: foreign.refreshToken }),
      status.UNAUTHENTICATED
    );
  });

  it("rejects an expired refresh token (signature valid)", async () => {
    const { service } = await harness({ refreshTtlSec: 1 });
    const tokens = await service.register({
      userName: USERNAME,
      password: PASSWORD
    });
    await sleep(1100);
    await expectGrpcError(
      service.revokeToken({ refreshToken: tokens.refreshToken }),
      status.UNAUTHENTICATED
    );
  }, 10_000);

  it("rejects a refresh token passed as the access_token parameter", async () => {
    const { service } = await harness();
    const pair = await service.register({
      userName: USERNAME,
      password: PASSWORD
    });
    await expectGrpcError(
      service.revokeToken({
        refreshToken: pair.refreshToken,
        accessToken: pair.refreshToken
      }),
      status.UNAUTHENTICATED
    );
  });

  it("rejects a forged access token", async () => {
    const { service } = await harness();
    const other = await harness();
    const pair = await service.register({
      userName: USERNAME,
      password: PASSWORD
    });
    const foreign = await other.tokens.issueTokenPair({
      id: "x",
      userName: "x",
      role: UserRole.Customer
    });
    await expectGrpcError(
      service.revokeToken({
        refreshToken: pair.refreshToken,
        accessToken: foreign.accessToken
      }),
      status.UNAUTHENTICATED
    );
  });
});

describe("AuthService.validateToken", () => {
  it("returns valid=true with the user context for a good access token", async () => {
    const { service, repository } = await harness();
    const pair = await service.register({
      userName: USERNAME,
      password: PASSWORD
    });
    const user = await repository.findUserByName(USERNAME);

    const res = await service.validateToken({
      accessToken: pair.accessToken
    });
    expect(res.valid).toBe(true);
    expect(res.user?.userId).toBe(user!.id);
    expect(res.user?.userName).toBe(USERNAME);
    expect(res.user?.role).toBe(UserRole.Customer);
  });

  it("returns valid=false for garbage, expired or denied tokens", async () => {
    const { service } = await harness({ accessTtlSec: 1 });
    expect(
      (await service.validateToken({ accessToken: "garbage" })).valid
    ).toBe(false);

    const pair = await service.register({
      userName: USERNAME,
      password: PASSWORD
    });
    await sleep(1100);
    expect(
      (await service.validateToken({ accessToken: pair.accessToken })).valid
    ).toBe(false);
  }, 10_000);

  it("returns valid=false when a refresh token is used as a bearer token", async () => {
    const { service } = await harness();
    const pair = await service.register({
      userName: USERNAME,
      password: PASSWORD
    });
    // typ="refresh" → JwtVerifier rejects it as an access token
    expect(
      (await service.validateToken({ accessToken: pair.refreshToken })).valid
    ).toBe(false);
  });

  it("returns valid=false for a revoked access token (denylist)", async () => {
    const { service } = await harness();
    const pair = await service.register({
      userName: USERNAME,
      password: PASSWORD
    });
    await service.revokeToken({
      refreshToken: pair.refreshToken,
      accessToken: pair.accessToken
    });
    expect(
      (await service.validateToken({ accessToken: pair.accessToken })).valid
    ).toBe(false);
  });
});

describe("AuthService.getUser — ownership rules", () => {
  const caller = (userId: string, role: UserRole) => ({
    userId,
    userName: "caller",
    role
  });

  it("returns the own profile for any role", async () => {
    const { service, repository } = await harness();
    await service.register({ userName: USERNAME, password: PASSWORD });
    const user = (await repository.findUserByName(USERNAME))!;

    const res = await service.getUser(
      { userId: user.id },
      caller(user.id, UserRole.Customer)
    );
    expect(res.userId).toBe(user.id);
    expect(res.userName).toBe(USERNAME);
    expect(res.role).toBe(UserRole.Customer);
  });

  it.each([UserRole.Admin, UserRole.Employer])(
    "allows a foreign profile for staff role %s",
    async (role) => {
      const { service, repository } = await harness();
      await service.register({ userName: USERNAME, password: PASSWORD });
      const user = (await repository.findUserByName(USERNAME))!;

      const res = await service.getUser(
        { userId: user.id },
        caller("staff-1", role)
      );
      expect(res.userId).toBe(user.id);
    }
  );

  it("denies a foreign profile for CUSTOMER (PERMISSION_DENIED)", async () => {
    const { service, repository } = await harness();
    await service.register({ userName: USERNAME, password: PASSWORD });
    const user = (await repository.findUserByName(USERNAME))!;

    await expectGrpcError(
      service.getUser(
        { userId: user.id },
        caller("other-1", UserRole.Customer)
      ),
      status.PERMISSION_DENIED
    );
  });

  it("requires authentication (no caller → UNAUTHENTICATED)", async () => {
    const { service, repository } = await harness();
    await service.register({ userName: USERNAME, password: PASSWORD });
    const user = (await repository.findUserByName(USERNAME))!;

    await expectGrpcError(
      service.getUser({ userId: user.id }, null),
      status.UNAUTHENTICATED
    );
  });

  it("returns NOT_FOUND for a missing user requested by staff", async () => {
    const { service } = await harness();
    await expectGrpcError(
      service.getUser({ userId: "missing" }, caller("admin-1", UserRole.Admin)),
      status.NOT_FOUND
    );
  });

  it("denies a missing user requested by a customer (PERMISSION_DENIED)", async () => {
    const { service } = await harness();
    await expectGrpcError(
      service.getUser(
        { userId: "missing" },
        caller("cust-1", UserRole.Customer)
      ),
      status.PERMISSION_DENIED
    );
  });
});
