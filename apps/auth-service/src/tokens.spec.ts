import { describe, expect, it } from "bun:test";
import {
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  jwtVerify,
  SignJWT
} from "jose";
import { UserRole } from "@book-shop/contracts";
import { TokenService } from "./tokens";

const USER = { id: "user-1", userName: "alice", role: UserRole.Customer };

async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    extractable: true
  });
  return {
    publicKeyPem: await exportSPKI(publicKey),
    privateKeyPem: await exportPKCS8(privateKey),
    publicKeyB64: Buffer.from(await exportSPKI(publicKey), "utf8").toString(
      "base64"
    ),
    privateKeyB64: Buffer.from(await exportPKCS8(privateKey), "utf8").toString(
      "base64"
    ),
    publicKey
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("TokenService — EdDSA (Ed25519) JWT issuing/verification", () => {
  it("issues an access token with {sub, user_name, role, jti} payload", async () => {
    const keys = await makeKeys();
    const tokens = new TokenService({
      privateKey: keys.privateKeyB64,
      accessTtlSec: 3600,
      refreshTtlSec: 86400
    });

    const pair = await tokens.issueTokenPair(USER);
    const { payload } = await jwtVerify(pair.accessToken, keys.publicKey, {
      algorithms: ["EdDSA"]
    });

    expect(payload.sub).toBe(USER.id);
    expect(payload.user_name).toBe(USER.userName);
    expect(payload.role).toBe(UserRole.Customer);
    // typ separates access from refresh — JwtVerifier requires "access"
    expect(payload.typ).toBe("access");
    // jti is a uuid — required for the Redis denylist on revoke
    expect(payload.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(payload.jti).toBe(pair.accessJti);
    // expires_in mirrors configured TTL
    expect(pair.accessTokenExpiresIn).toBe(3600);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(3600);
  });

  it("issues a refresh token with a distinct jti and refresh TTL", async () => {
    const keys = await makeKeys();
    const tokens = new TokenService({
      privateKey: keys.privateKeyB64,
      accessTtlSec: 3600,
      refreshTtlSec: 86400
    });

    const pair = await tokens.issueTokenPair(USER);
    expect(pair.refreshJti).not.toBe(pair.accessJti);
    expect(pair.refreshTokenExpiresIn).toBe(86400);
    // refresh jti is a uuid — it is the primary key of refresh_tokens
    expect(pair.refreshJti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    const claims = await tokens.verifyRefreshToken(pair.refreshToken);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe(USER.id);
    expect(claims?.jti).toBe(pair.refreshJti);
    expect(claims?.typ).toBe("refresh");
  });

  it("rejects tokens of the wrong type on each verify path", async () => {
    const keys = await makeKeys();
    const tokens = new TokenService({
      privateKey: keys.privateKeyB64,
      accessTtlSec: 3600,
      refreshTtlSec: 86400
    });
    const pair = await tokens.issueTokenPair(USER);

    // an access token must not pass as a refresh token …
    expect(await tokens.verifyRefreshToken(pair.accessToken)).toBeNull();
    // … and a refresh token must not be accepted as an access token
    expect(
      await tokens.verifyAccessSignatureOnly(pair.refreshToken)
    ).toBeNull();
  });

  it("verifyRefreshToken rejects a validly-signed token without typ", async () => {
    const keys = await makeKeys();
    const tokens = new TokenService({
      privateKey: keys.privateKeyB64,
      accessTtlSec: 3600,
      refreshTtlSec: 86400
    });
    // legacy shape: all claims except typ — must not pass either verify
    const legacy = await new SignJWT({
      user_name: USER.userName,
      role: USER.role
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject(USER.id)
      .setJti("jti-no-typ")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(await importPKCS8(keys.privateKeyPem, "EdDSA"));

    expect(await tokens.verifyRefreshToken(legacy)).toBeNull();
    expect(await tokens.verifyAccessSignatureOnly(legacy)).toBeNull();
  });

  it("onModuleInit rejects a malformed private key (fail fast)", async () => {
    const tokens = new TokenService({
      privateKey: Buffer.from("not-a-pem-key", "utf8").toString("base64"),
      accessTtlSec: 3600,
      refreshTtlSec: 86400
    });
    await expect(tokens.onModuleInit()).rejects.toThrow();
  });

  it("verifyRefreshToken returns null for garbage and forged signatures", async () => {
    const keys = await makeKeys();
    const otherKeys = await makeKeys();
    const tokens = new TokenService({
      privateKey: keys.privateKeyB64,
      accessTtlSec: 3600,
      refreshTtlSec: 86400
    });
    const forgedTokens = new TokenService({
      privateKey: otherKeys.privateKeyB64,
      accessTtlSec: 3600,
      refreshTtlSec: 86400
    });
    const forged = await forgedTokens.issueTokenPair(USER);

    expect(await tokens.verifyRefreshToken("not-a-jwt")).toBeNull();
    expect(await tokens.verifyRefreshToken(forged.refreshToken)).toBeNull();
  });

  it("expires tokens after their TTL (real wait, TTL=1s)", async () => {
    const keys = await makeKeys();
    const tokens = new TokenService({
      privateKey: keys.privateKeyB64,
      accessTtlSec: 1,
      refreshTtlSec: 1
    });

    const pair = await tokens.issueTokenPair(USER);
    expect(await tokens.verifyRefreshToken(pair.refreshToken)).not.toBeNull();

    await sleep(1100);

    expect(await tokens.verifyRefreshToken(pair.refreshToken)).toBeNull();
    await expect(
      jwtVerify(pair.accessToken, keys.publicKey, { algorithms: ["EdDSA"] })
    ).rejects.toThrow();
  }, 10_000);

  it("verifyAccessSignatureOnly accepts expired-but-signed tokens (for revoke denylist TTL)", async () => {
    const keys = await makeKeys();
    const tokens = new TokenService({
      privateKey: keys.privateKeyB64,
      accessTtlSec: 1,
      refreshTtlSec: 1
    });

    const pair = await tokens.issueTokenPair(USER);
    await sleep(1100);

    // expired access: regular verification fails, but signature-only
    // check still yields claims so RevokeToken can compute TTL = exp - now
    await expect(
      jwtVerify(pair.accessToken, keys.publicKey, { algorithms: ["EdDSA"] })
    ).rejects.toThrow();
    const claims = await tokens.verifyAccessSignatureOnly(pair.accessToken);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe(USER.id);
    expect(claims?.jti).toBe(pair.accessJti);
    expect(claims?.exp).toBeGreaterThan(0);
    expect(claims?.exp ?? 0).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  }, 10_000);

  it("verifyAccessSignatureOnly returns null for forged or malformed tokens", async () => {
    const keys = await makeKeys();
    const otherKeys = await makeKeys();
    const tokens = new TokenService({
      privateKey: keys.privateKeyB64,
      accessTtlSec: 3600,
      refreshTtlSec: 86400
    });
    const forgedTokens = new TokenService({
      privateKey: otherKeys.privateKeyB64,
      accessTtlSec: 3600,
      refreshTtlSec: 86400
    });
    const forged = await forgedTokens.issueTokenPair(USER);

    expect(await tokens.verifyAccessSignatureOnly("garbage")).toBeNull();
    expect(
      await tokens.verifyAccessSignatureOnly(forged.accessToken)
    ).toBeNull();
  });
});
