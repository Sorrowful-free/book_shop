// Composition root (spec §5/§7): Prisma repository + service, JWT
// verification (JwtVerifier + RedisTokenDenylist, read-only denylist),
// transactional outbox relay (OutboxRelay over PrismaOutboxStore +
// lazily-connected KafkaEventPublisher) and the reservation sweeper.

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
  OutboxRelay,
  RedisTokenDenylist,
  resolveSecret
} from "@book-shop/common";
import { CatalogController } from "./catalog.controller";
import { CatalogService } from "./catalog.service";
import { KafkaEventPublisher, PrismaOutboxStore } from "./outbox";
import { PrismaCatalogRepository } from "./prisma.repository";
import { PrismaService } from "./prisma.service";
import { ReservationSweeper } from "./reservation-sweeper";

const REDIS_CLIENT = "REDIS_CLIENT";
const OUTBOX_RELAY = "OUTBOX_RELAY";

const logger = new Logger("AppModule");

function envOr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(
      `Environment variable ${key} must be a number, got "${raw}"`
    );
  }
  return value;
}

@Module({
  controllers: [CatalogController],
  providers: [
    PrismaService,
    PrismaCatalogRepository,
    PrismaOutboxStore,
    {
      provide: CatalogService,
      useFactory: (repository: PrismaCatalogRepository) =>
        new CatalogService({
          repository,
          reservationTtlSec: envInt("RESERVATION_TTL_SEC", 900)
        }),
      inject: [PrismaCatalogRepository]
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
        new KafkaEventPublisher(
          envOr("KAFKA_BROKERS", "localhost:29092")
            .split(",")
            .map((broker) => broker.trim())
            .filter((broker) => broker.length > 0)
        )
    },
    {
      provide: OUTBOX_RELAY,
      useFactory: (store: PrismaOutboxStore, publisher: KafkaEventPublisher) =>
        new OutboxRelay(store, publisher, {
          onError: (error: unknown) =>
            logger.error("outbox relay tick failed", error)
        }),
      inject: [PrismaOutboxStore, KafkaEventPublisher]
    },
    {
      provide: ReservationSweeper,
      useFactory: (prisma: PrismaService) =>
        new ReservationSweeper({
          prisma,
          intervalSec: envInt("RESERVATION_SWEEP_INTERVAL_SEC", 60)
        }),
      inject: [PrismaService]
    }
  ]
})
export class AppModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(OUTBOX_RELAY) private readonly outboxRelay: OutboxRelay,
    private readonly kafkaPublisher: KafkaEventPublisher,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {}

  onModuleInit(): void {
    this.outboxRelay.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.outboxRelay.stop();
    await this.kafkaPublisher.close();
    await this.redis.quit();
  }
}
