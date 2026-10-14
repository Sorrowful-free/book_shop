// Composition root (spec §5/§7): lazily-connected grpc-js clients to all
// four services (the gateway boots with upstreams down — the per-call 5s
// deadline bounds the wait), local JWT verification (JwtVerifier +
// RedisTokenDenylist — the gateway only READS `auth:revoked:{jti}`;
// auth-service is the sole writer) and the COOKIE_SECURE env flag.

import { Inject, Logger, Module, type OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import {
  JwtVerifier,
  RedisTokenDenylist,
  resolveSecret
} from "@book-shop/common";
import {
  createAuthGrpcClient,
  createCartGrpcClient,
  createCatalogGrpcClient,
  createOrderGrpcClient,
  type AuthClient,
  type CartClient,
  type CatalogClient,
  type Closeable,
  type OrderClient
} from "./clients";
import {
  AUTH_CLIENT,
  CART_CLIENT,
  CATALOG_CLIENT,
  COOKIE_SECURE,
  ORDER_CLIENT,
  REDIS_CLIENT
} from "./tokens";
import { AuthGuard, RolesGuard } from "./guards";
import { AuthController } from "./controllers/auth.controller";
import { BooksController } from "./controllers/books.controller";
import { CartController } from "./controllers/cart.controller";
import { CoversController } from "./controllers/covers.controller";
import { OrdersController } from "./controllers/orders.controller";

const logger = new Logger("AppModule");

function envOr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

@Module({
  controllers: [
    AuthController,
    BooksController,
    CartController,
    CoversController,
    OrdersController
  ],
  providers: [
    AuthGuard,
    RolesGuard,
    {
      provide: AUTH_CLIENT,
      useFactory: (): AuthClient & Closeable =>
        createAuthGrpcClient(envOr("AUTH_GRPC_ADDR", "localhost:50051"))
    },
    {
      provide: CATALOG_CLIENT,
      useFactory: (): CatalogClient & Closeable =>
        createCatalogGrpcClient(envOr("CATALOG_GRPC_ADDR", "localhost:50052"))
    },
    {
      provide: CART_CLIENT,
      useFactory: (): CartClient & Closeable =>
        createCartGrpcClient(envOr("CART_GRPC_ADDR", "localhost:50053"))
    },
    {
      provide: ORDER_CLIENT,
      useFactory: (): OrderClient & Closeable =>
        createOrderGrpcClient(envOr("ORDER_GRPC_ADDR", "localhost:50054"))
    },
    {
      // Redis — JWT denylist reads only (`auth:revoked:{jti}`). Fail fast:
      // denylist reads must not hang an HTTP request queueing behind a dead
      // Redis — return an error immediately instead.
      provide: REDIS_CLIENT,
      useFactory: () => {
        const redis = new Redis(envOr("REDIS_URL", "redis://localhost:6379"), {
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1
        });
        redis.on("error", (error: Error) =>
          logger.error("redis client error", error)
        );
        return redis;
      }
    },
    {
      provide: JwtVerifier,
      useFactory: (redis: Redis) =>
        // JWT_PUBLIC_KEY_FILE (docker secrets) wins over inline (F-A3)
        new JwtVerifier({
          publicKey: resolveSecret("JWT_PUBLIC_KEY"),
          denylist: new RedisTokenDenylist(redis)
        }),
      inject: [REDIS_CLIENT]
    },
    {
      provide: COOKIE_SECURE,
      useFactory: () => process.env.COOKIE_SECURE === "true"
    }
  ]
})
export class AppModule implements OnModuleDestroy {
  constructor(
    @Inject(AUTH_CLIENT) private readonly authClient: Closeable,
    @Inject(CATALOG_CLIENT) private readonly catalogClient: Closeable,
    @Inject(CART_CLIENT) private readonly cartClient: Closeable,
    @Inject(ORDER_CLIENT) private readonly orderClient: Closeable,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {}

  onModuleDestroy(): void {
    this.authClient.close();
    this.catalogClient.close();
    this.cartClient.close();
    this.orderClient.close();
    this.redis.disconnect();
  }
}
