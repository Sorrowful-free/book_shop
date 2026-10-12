import type Redis from "ioredis";
import type { TokenDenylistWriter } from "./denylist";

/**
 * Redis denylist write side (spec §2): key `auth:revoked:{jti}` = "1",
 * TTL = remaining seconds until the access token's exp. auth-service is
 * the only writer; every JwtVerifier (packages/common) reads via
 * TokenDenylist.isRevoked.
 */
export class RedisTokenDenylistWriter implements TokenDenylistWriter {
  constructor(
    private readonly client: Redis,
    private readonly prefix = "auth:revoked:"
  ) {}

  /**
   * Record `jti` as revoked for `ttlSeconds`. Callers skip the write when
   * ttlSeconds <= 0 (already-expired token — nothing left to revoke).
   */
  async revoke(jti: string, ttlSeconds: number): Promise<void> {
    await this.client.set(
      this.prefix + jti,
      "1",
      "EX",
      Math.max(1, Math.floor(ttlSeconds))
    );
  }
}
