import {
  Module,
  type OnModuleDestroy,
  type OnModuleInit
} from "@nestjs/common";
import { PrismaClient } from "./generated/prisma";
import Redis from "ioredis";
import {
  JwtVerifier,
  OutboxRelay,
  RedisTokenDenylist,
  resolveSecret,
  type OutboxStore
} from "@book-shop/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import type { TokenDenylistWriter } from "./denylist";
import { RedisTokenDenylistWriter } from "./denylist.redis";
import { hashPassword } from "./password";
import { KafkaEventPublisher } from "./publisher.kafka";
import { RefreshTokenSweeper } from "./refresh-token-sweeper";
import type { AuthRepository } from "./repository";
import { PrismaAuthRepository, PrismaOutboxStore } from "./repository.prisma";
import { TokenService } from "./tokens";

/** Injection tokens for interface-typed providers. */
const AUTH_REPOSITORY = "AUTH_REPOSITORY";
const OUTBOX_STORE = "OUTBOX_STORE";
const DENYLIST_WRITER = "DENYLIST_WRITER";

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(env(name, String(fallback)), 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer`);
  }
  return parsed;
}

/**
 * Root NestJS module. Wires: Prisma-backed AuthRepository + OutboxStore,
 * TokenService (EdDSA, env keys), ioredis denylist reader/writer,
 * JwtVerifier, KafkaEventPublisher (lazy connect — the service boots with
 * the broker down), OutboxRelay, seed admin, AuthService gRPC controller.
 */
@Module({
  controllers: [AuthController],
  providers: [
    PrismaClient,
    {
      provide: Redis,
      // fail fast when Redis is down: no offline queue (commands reject
      // instead of hanging forever) and a single attempt per request — a
      // dead Redis must not stall every denylist-reading RPC
      useFactory: () => {
        const redis = new Redis(env("REDIS_URL", "redis://localhost:6379"), {
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1
        });
        redis.on("error", (error: Error) =>
          console.error("[redis]", error.message)
        );
        return redis;
      }
    },
    {
      provide: AUTH_REPOSITORY,
      useFactory: (prisma: PrismaClient): AuthRepository =>
        new PrismaAuthRepository(prisma),
      inject: [PrismaClient]
    },
    {
      provide: OUTBOX_STORE,
      useFactory: (prisma: PrismaClient): OutboxStore =>
        new PrismaOutboxStore(prisma),
      inject: [PrismaClient]
    },
    {
      provide: TokenService,
      useFactory: () =>
        new TokenService({
          // *_FILE variants (docker secrets) win over inline values (F-A3)
          privateKey: resolveSecret("JWT_PRIVATE_KEY"),
          accessTtlSec: envInt("JWT_ACCESS_TTL_SEC", 28800),
          refreshTtlSec: envInt("JWT_REFRESH_TTL_SEC", 2592000)
        })
    },
    {
      provide: DENYLIST_WRITER,
      useFactory: (redis: Redis): TokenDenylistWriter =>
        new RedisTokenDenylistWriter(redis),
      inject: [Redis]
    },
    {
      provide: JwtVerifier,
      useFactory: (redis: Redis) =>
        new JwtVerifier({
          publicKey: resolveSecret("JWT_PUBLIC_KEY"),
          denylist: new RedisTokenDenylist(redis)
        }),
      inject: [Redis]
    },
    {
      provide: KafkaEventPublisher,
      useFactory: () =>
        new KafkaEventPublisher(
          env("KAFKA_BROKERS", "localhost:29092").split(",")
        )
    },
    {
      provide: OutboxRelay,
      useFactory: (store: OutboxStore, publisher: KafkaEventPublisher) =>
        new OutboxRelay(store, publisher, {
          onError: (error) => console.error("[outbox-relay]", error)
        }),
      inject: [OUTBOX_STORE, KafkaEventPublisher]
    },
    {
      provide: AuthService,
      useFactory: (
        repository: AuthRepository,
        tokens: TokenService,
        denylist: TokenDenylistWriter,
        verifier: JwtVerifier
      ) => new AuthService({ repository, tokens, denylist, verifier }),
      inject: [AUTH_REPOSITORY, TokenService, DENYLIST_WRITER, JwtVerifier]
    },
    {
      // GC for refresh_tokens (F-A1): deletes rows whose expires_at is
      // older than REFRESH_TOKEN_AUDIT_TTL_SEC; lifecycle hooks start/stop
      // the unref'd interval automatically.
      provide: RefreshTokenSweeper,
      useFactory: (repository: AuthRepository) =>
        new RefreshTokenSweeper({
          repository,
          retentionSec: envInt("REFRESH_TOKEN_AUDIT_TTL_SEC", 604800),
          intervalSec: envInt("REFRESH_TOKEN_SWEEP_INTERVAL_SEC", 3600)
        }),
      inject: [AUTH_REPOSITORY]
    }
  ]
})
export class AppModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly relay: OutboxRelay,
    private readonly publisher: KafkaEventPublisher
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedAdmin();
    // in-process outbox poller — publishes at-least-once; a dead broker
    // only delays delivery, never blocks RPCs (spec §4)
    this.relay.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.relay.stop();
    await this.publisher.close().catch(() => undefined);
    this.redis.disconnect();
    await this.prisma.$disconnect().catch(() => undefined);
  }

  /** Seed the admin from SEED_ADMIN_* env (defaults admin/admin, spec §3/§7). */
  private async seedAdmin(): Promise<void> {
    await seedAdminUser(this.prisma, {
      userName: env("SEED_ADMIN_USER_NAME", "admin"),
      password: env("SEED_ADMIN_PASSWORD", "admin")
    });
  }
}

/**
 * Idempotent admin seeding (spec §3/§7): an existing admin is left
 * untouched — and the argon2 hash is computed lazily ONLY when the user has
 * to be created (F-A2), so a warm boot doesn't pay ~50ms of CPU for a
 * discarded value. `hash` is injectable so the laziness is testable without
 * a module mock (a global `mock.module` would leak into other test files
 * sharing the process).
 */
export async function seedAdminUser(
  prisma: Pick<PrismaClient, "user">,
  options: {
    userName: string;
    password: string;
    hash?: (password: string) => Promise<string>;
  }
): Promise<void> {
  if (await prisma.user.findUnique({ where: { userName: options.userName } })) {
    return;
  }
  const passwordHash = await (options.hash ?? hashPassword)(options.password);
  await prisma.user.upsert({
    where: { userName: options.userName },
    update: {},
    create: { userName: options.userName, passwordHash, role: "ADMIN" }
  });
}
