import { randomUUID } from "node:crypto";
import {
  compactVerify,
  exportJWK,
  importJWK,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWTPayload
} from "jose";
import type { UserRole } from "@book-shop/contracts";

/**
 * JWT issuing/verification: jose, EdDSA/Ed25519, private key held only by
 * auth-service. Access payload: {sub=userId, user_name, role, jti(uuid),
 * typ="access"}; refresh payload is identical except typ="refresh". The
 * `typ` claim is strict: refresh tokens are not usable as bearer access
 * tokens and vice versa (JwtVerifier requires typ="access").
 */

export interface TokenServiceOptions {
  /** Ed25519 private key as base64-encoded PEM (env JWT_PRIVATE_KEY). */
  privateKey: string;
  /** Access token TTL in seconds (env JWT_ACCESS_TTL_SEC). */
  accessTtlSec: number;
  /** Refresh token TTL in seconds (env JWT_REFRESH_TTL_SEC). */
  refreshTtlSec: number;
}

export interface TokenUser {
  id: string;
  userName: string;
  role: UserRole;
}

export interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
  /** Access JWT jti (uuid) — written to the Redis denylist on revoke. */
  accessJti: string;
  /** Refresh JWT jti (uuid) — primary key of refresh_tokens. */
  refreshJti: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

/** Verified JWT claims relevant to auth-service. */
export interface TokenClaims {
  sub: string;
  user_name?: string;
  role?: string;
  jti: string;
  /** "access" | "refresh" — strictly enforced on both verify paths. */
  typ?: string;
  iat?: number;
  exp?: number;
}

export class TokenService {
  private readonly signKeyPromise: Promise<CryptoKey>;
  private readonly verifyKeyPromise: Promise<CryptoKey>;
  /** Resolves once both keys are imported; rejects on a malformed key. */
  private readonly ready: Promise<void>;
  private readonly accessTtlSec: number;
  private readonly refreshTtlSec: number;

  constructor(options: TokenServiceOptions) {
    const pem = options.privateKey.startsWith("-----BEGIN")
      ? options.privateKey
      : Buffer.from(options.privateKey, "base64").toString("utf8");
    // PKCS8 yields a sign-only CryptoKey — verification needs the public half,
    // derived via the JWK `x` coordinate.
    this.signKeyPromise = importPKCS8(pem, "EdDSA", {
      extractable: true
    }) as Promise<CryptoKey>;
    this.verifyKeyPromise = this.signKeyPromise.then(async (privateKey) => {
      const { kty, crv, x } = await exportJWK(privateKey);
      return importJWK({ kty, crv, x }, "EdDSA") as Promise<CryptoKey>;
    });
    this.ready = this.verifyKeyPromise.then(() => undefined);
    // mark handled so a bad key never trips unhandledRejection — the
    // rejection still surfaces to onModuleInit / the signing methods
    this.ready.catch(() => undefined);
    this.accessTtlSec = options.accessTtlSec;
    this.refreshTtlSec = options.refreshTtlSec;
  }

  /**
   * Nest lifecycle hook (duck-typed — no @nestjs import needed here):
   * key import is awaited during module init, so a malformed
   * JWT_PRIVATE_KEY fails bootstrap instead of the first RPC.
   */
  async onModuleInit(): Promise<void> {
    await this.ready;
  }

  /** Sign a new access+refresh pair; each token gets its own uuid jti. */
  async issueTokenPair(user: TokenUser): Promise<IssuedTokenPair> {
    const key = await this.signKeyPromise;
    const accessJti = randomUUID();
    const refreshJti = randomUUID();
    const [accessToken, refreshToken] = await Promise.all([
      this.sign(key, user, accessJti, this.accessTtlSec, "access"),
      this.sign(key, user, refreshJti, this.refreshTtlSec, "refresh")
    ]);
    return {
      accessToken,
      refreshToken,
      accessJti,
      refreshJti,
      accessTokenExpiresIn: this.accessTtlSec,
      refreshTokenExpiresIn: this.refreshTtlSec
    };
  }

  /**
   * Full verification of a refresh token (signature + expiry + typ claim).
   * Returns null for malformed, forged, expired or non-refresh tokens —
   * an access token presented as a refresh token is rejected here.
   */
  async verifyRefreshToken(token: string): Promise<TokenClaims | null> {
    try {
      const { payload } = await jwtVerify(token, await this.verifyKeyPromise, {
        algorithms: ["EdDSA"]
      });
      const claims = this.toClaims(payload);
      return claims?.typ === "refresh" ? claims : null;
    } catch {
      return null;
    }
  }

  /**
   * Signature-only verification of an access token — expiry is NOT checked.
   * Used by RevokeToken to compute denylist TTL = exp - now for tokens that
   * may already be expired (spec §2). Returns null on bad signature/format
   * or a non-access token (a refresh token must not reach the denylist).
   */
  async verifyAccessSignatureOnly(token: string): Promise<TokenClaims | null> {
    try {
      // compactVerify checks the JWS signature only — no claim validation,
      // so an expired-but-signed token still yields its claims.
      const { payload } = await compactVerify(
        token,
        await this.verifyKeyPromise
      );
      const claims = JSON.parse(
        new TextDecoder().decode(payload)
      ) as JWTPayload;
      const parsed = this.toClaims(claims);
      return parsed?.typ === "access" ? parsed : null;
    } catch {
      return null;
    }
  }

  private sign(
    key: CryptoKey,
    user: TokenUser,
    jti: string,
    ttlSec: number,
    typ: "access" | "refresh"
  ): Promise<string> {
    // single clock read so exp - iat is exactly ttlSec
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT({ user_name: user.userName, role: user.role, typ })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject(user.id)
      .setJti(jti)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttlSec)
      .sign(key);
  }

  private toClaims(payload: JWTPayload): TokenClaims | null {
    if (typeof payload.sub !== "string" || typeof payload.jti !== "string") {
      return null;
    }
    const str = (value: unknown): string | undefined =>
      typeof value === "string" ? value : undefined;
    return {
      sub: payload.sub,
      jti: payload.jti,
      user_name: str(payload.user_name),
      role: str(payload.role),
      typ: str(payload.typ),
      iat: payload.iat,
      exp: payload.exp
    };
  }
}
