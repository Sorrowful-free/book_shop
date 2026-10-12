import type { UserRole } from "@book-shop/contracts";

/**
 * JWT issuing/verification — TYPE DECLARATIONS ONLY (TDD contract phase).
 * Implementation (spec §6/§9): jose, EdDSA/Ed25519, private key held only by
 * auth-service. Access payload: {sub=userId, user_name, role, jti(uuid)}.
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
  iat?: number;
  exp?: number;
}

export declare class TokenService {
  constructor(options: TokenServiceOptions);

  /** Sign a new access+refresh pair; each token gets its own uuid jti. */
  issueTokenPair(user: TokenUser): Promise<IssuedTokenPair>;

  /**
   * Full verification of a refresh token (signature + expiry).
   * Returns null for malformed, forged or expired tokens.
   */
  verifyRefreshToken(token: string): Promise<TokenClaims | null>;

  /**
   * Signature-only verification of an access token — expiry is NOT checked.
   * Used by RevokeToken to compute denylist TTL = exp - now for tokens that
   * may already be expired (spec §2). Returns null on bad signature/format.
   */
  verifyAccessSignatureOnly(token: string): Promise<TokenClaims | null>;
}
