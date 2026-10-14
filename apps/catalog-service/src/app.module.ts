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
  KafkaEventPublisher,
  OutboxRelay,
  PrismaOutboxStore,
  RedisTokenDenylist,
  resolveSecret
} from "@book-shop/common";
import { CatalogController } from "./catalog.controller";
import { CatalogService } from "./catalog.service";
import { CoversService } from "./covers/covers.service";
import { MinioCoverStorage } from "./covers/minio-cover-storage";
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
    {
      provide: PrismaOutboxStore,
      useFactory: (prisma: PrismaService) => new PrismaOutboxStore(prisma),
      inject: [PrismaService]
    },
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
      // Cover object store (spec 08 §4/§8): ops calls go to the internal
      // S3_ENDPOINT, presigns are computed for the browser-reachable
      // S3_PUBLIC_ENDPOINT — one client per endpoint inside the adapter.
      provide: MinioCoverStorage,
      useFactory: () =>
        new MinioCoverStorage({
          endpoint: envOr("S3_ENDPOINT", "http://localhost:9000"),
          publicEndpoint: envOr("S3_PUBLIC_ENDPOINT", "http://localhost:9000"),
          bucket: envOr("S3_BUCKET", "book-covers"),
          region: envOr("S3_REGION", "us-east-1"),
          // <NAME>_FILE (docker secrets) wins over inline (repo convention)
          accessKey: resolveSecret("S3_ACCESS_KEY"),
          secretKey: resolveSecret("S3_SECRET_KEY")
        })
    },
    {
      provide: CoversService,
      useFactory: (storage: MinioCoverStorage) =>
        new CoversService({
          storage,
          maxUploadBytes: envInt("COVER_UPLOAD_MAX_BYTES", 2 * 1024 * 1024),
          uploadTtlSec: envInt("COVER_UPLOAD_TTL_SEC", 600)
        }),
      inject: [MinioCoverStorage]
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
        // key = bookId: all events for one book share a partition and
        // stay ordered (spec §4)
        new KafkaEventPublisher({
          brokers: envOr("KAFKA_BROKERS", "localhost:29092")
            .split(",")
            .map((broker) => broker.trim())
            .filter((broker) => broker.length > 0),
          clientId: "catalog-service",
          keyField: "bookId"
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
