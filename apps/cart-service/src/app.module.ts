import { Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";
import {
  JwtVerifier,
  RedisTokenDenylist,
  resolveSecret
} from "@book-shop/common";
import { CartController } from "./cart.controller";
import { CartService } from "./cart.service";
import { RedisCartRepository, type CartRepository } from "./repository";

export const REDIS_CLIENT = Symbol("REDIS_CLIENT");
export const CART_REPOSITORY = Symbol("CART_REPOSITORY");

const DEFAULT_REDIS_URL = "redis://localhost:6379";
const DEFAULT_CART_TTL_SEC = 604800; // 7 days (spec §7/§11)

function cartTtlFromEnv(): number {
  const raw = process.env.CART_TTL_SEC;
  if (raw === undefined) {
    return DEFAULT_CART_TTL_SEC;
  }
  const ttl = Number(raw);
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error(`CART_TTL_SEC must be a positive integer, got "${raw}"`);
  }
  return ttl;
}

/**
 * Composition root (docs/specs/03-cart-service.md):
 * - one shared ioredis client (same REDIS_URL) backs the cart repository AND
 *   the JWT denylist reads `auth:revoked:{jti}` (auth-service is the writer)
 * - CartController answers the gRPC surface; its @EventPattern handler turns
 *   the hybrid Kafka transport (`order.order.events`, group `cart-service`)
 *   into `CartService.handleOrderCreated`
 * - env is read inside provider factories so each app instance honors the
 *   env present at creation time (e2e boots two apps with different TTLs)
 */
@Module({
  controllers: [CartController],
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): Redis =>
        // Redis is the PRIMARY store — keep the offline queue enabled, but
        // bound it: a dead Redis must fail RPCs (UNAVAILABLE via the gRPC
        // layer) instead of buffering commands past client deadlines.
        new Redis(process.env.REDIS_URL ?? DEFAULT_REDIS_URL, {
          commandTimeout: 2000,
          maxRetriesPerRequest: 3
        })
    },
    {
      provide: CART_REPOSITORY,
      useFactory: (redis: Redis): CartRepository =>
        new RedisCartRepository(redis),
      inject: [REDIS_CLIENT]
    },
    {
      provide: CartService,
      useFactory: (repository: CartRepository): CartService =>
        new CartService({ repository, cartTtlSec: cartTtlFromEnv() }),
      inject: [CART_REPOSITORY]
    },
    {
      provide: JwtVerifier,
      useFactory: (redis: Redis): JwtVerifier =>
        // JWT_PUBLIC_KEY_FILE (docker secrets) wins over inline (F-A3)
        new JwtVerifier({
          publicKey: resolveSecret("JWT_PUBLIC_KEY"),
          denylist: new RedisTokenDenylist(redis)
        }),
      inject: [REDIS_CLIENT]
    }
  ]
})
export class AppModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
