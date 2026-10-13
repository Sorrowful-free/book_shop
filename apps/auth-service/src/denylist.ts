/**
 * Redis denylist write side (spec §2): key `auth:revoked:{jti}` = "1",
 * TTL = remaining seconds until the access token's exp. auth-service is the
 * only writer (Redis impl in denylist.redis.ts); every JwtVerifier
 * (packages/common) reads via TokenDenylist.isRevoked.
 */

export interface TokenDenylistWriter {
  /**
   * Record `jti` as revoked for `ttlSeconds`. Callers skip the write when
   * ttlSeconds <= 0 (already-expired token — nothing left to revoke).
   */
  revoke(jti: string, ttlSeconds: number): Promise<void>;
}
