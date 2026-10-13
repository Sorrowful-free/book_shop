// Composition root (spec §5/§7): Prisma repository + order service, JWT
// verification (JwtVerifier + RedisTokenDenylist, read-only denylist),
// outbound gRPC clients to cart/catalog (lazily connected — the service
// boots with dependencies down) and the transactional outbox relay
// (OutboxRelay over PrismaOutboxStore + lazily-connected
// KafkaEventPublisher).

import {
  Inject,
  Logger,
  Module,
  type OnModuleDestroy,
  type OnModuleInit
} from "@nestjs/common";
import Redis from "ioredis";
import {
  JwtVerifier,
  KafkaEventPublisher,
  OutboxRelay,
  PrismaOutboxStore,
  RedisTokenDenylist,
  resolveSecret
} from "@book-shop/common";
import {
  createCartGrpcClient,
  createCatalogGrpcClient,
  type CartClient,
  type CatalogClient,
  type Closeable
} from "./clients";
import { OrderController } from "./order.controller";
import { OrderService } from "./order.service";
import { PrismaOrderRepository } from "./prisma.repository";
import { PrismaService } from "./prisma.service";

const REDIS_CLIENT = "REDIS_CLIENT";
const OUTBOX_RELAY = "OUTBOX_RELAY";
const CART_CLIENT = "CART_CLIENT";
const CATALOG_CLIENT = "CATALOG_CLIENT";

const logger = new Logger("AppModule");

function envOr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

@Module({
  controllers: [OrderController],
  providers: [
    PrismaService,
    PrismaOrderRepository,
    {
      provide: PrismaOutboxStore,
      useFactory: (prisma: PrismaService) => new PrismaOutboxStore(prisma),
      inject: [PrismaService]
    },
    {
      // grpc-js channels connect lazily on first call — a dead dependency
      // does not block bootstrap; the per-call 5s deadline bounds the wait.
      provide: CART_CLIENT,
      useFactory: (): CartClient & Closeable =>
        createCartGrpcClient(envOr("CART_GRPC_ADDR", "localhost:50053"))
    },
    {
      provide: CATALOG_CLIENT,
      useFactory: (): CatalogClient & Closeable =>
        createCatalogGrpcClient(envOr("CATALOG_GRPC_ADDR", "localhost:50052"))
    },
    {
      provide: OrderService,
      useFactory: (
        repository: PrismaOrderRepository,
        cart: CartClient,
        catalog: CatalogClient
      ) => new OrderService({ repository, cart, catalog }),
      inject: [PrismaOrderRepository, CART_CLIENT, CATALOG_CLIENT]
    },
    {
      // Redis — JWT denylist reads only (`auth:revoked:{jti}`)
      provide: REDIS_CLIENT,
      useFactory: () => {
        const redis = new Redis(envOr("REDIS_URL", "redis://localhost:6379"), {
          // Fail fast: denylist reads must not hang a gRPC call queueing
          // behind a dead Redis — return an error immediately instead.
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
        new JwtVerifier({
          // JWT_PUBLIC_KEY_FILE (docker secrets) wins over inline (F-A3)
          publicKey: resolveSecret("JWT_PUBLIC_KEY"),
          denylist: new RedisTokenDenylist(redis)
        }),
      inject: [REDIS_CLIENT]
    },
    {
      provide: KafkaEventPublisher,
      useFactory: () =>
        // key = userId: all events for one user's orders share a partition
        // and stay ordered (spec §4)
        new KafkaEventPublisher({
          brokers: envOr("KAFKA_BROKERS", "localhost:29092")
            .split(",")
            .map((broker) => broker.trim())
            .filter((broker) => broker.length > 0),
          clientId: "order-service",
          keyField: "userId"
        })
    },
    {
      provide: OUTBOX_RELAY,
      useFactory: (store: PrismaOutboxStore, publisher: KafkaEventPublisher) =>
        new OutboxRelay(store, publisher, {
          onError: (error: unknown) =>
            logger.error("outbox relay tick failed", error)
        }),
      inject: [PrismaOutboxStore, KafkaEventPublisher]
    }
  ]
})
export class AppModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(OUTBOX_RELAY) private readonly outboxRelay: OutboxRelay,
    private readonly kafkaPublisher: KafkaEventPublisher,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(CART_CLIENT) private readonly cartClient: Closeable,
    @Inject(CATALOG_CLIENT) private readonly catalogClient: Closeable
  ) {}

  onModuleInit(): void {
    this.outboxRelay.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.outboxRelay.stop();
    this.cartClient.close();
    this.catalogClient.close();
    await this.kafkaPublisher.close();
    await this.redis.quit();
  }
}
