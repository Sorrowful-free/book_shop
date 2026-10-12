import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Metadata, status } from "@grpc/grpc-js";
import type { INestMicroservice } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientProxyFactory,
  Transport,
  type ClientGrpc,
  type MicroserviceOptions
} from "@nestjs/microservices";
import type { Consumer } from "kafkajs";
import { Kafka } from "kafkajs";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { lastValueFrom, type Observable } from "rxjs";
import { authProto, EVENT_TYPES, KAFKA_TOPICS } from "@book-shop/contracts";

const APP_DIR = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  ".."
);
const PROTO_PATH = createRequire(import.meta.url).resolve(
  "@book-shop/contracts/proto/auth.proto"
);
const GRPC_PACKAGE = authProto.BOOKSHOP_AUTH_V1_PACKAGE_NAME;
const PASSWORD = "Str0ng!pass";
const uniqueName = () => `u_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

type AuthClient = authProto.AuthServiceClient;

const openProxies: { close(): unknown }[] = [];

function grpcClient(url: string): AuthClient {
  const proxy = ClientProxyFactory.create({
    transport: Transport.GRPC,
    options: {
      package: GRPC_PACKAGE,
      protoPath: PROTO_PATH,
      url,
      loader: { keepCase: false, longs: Number, defaults: true }
    }
  });
  // Open client channels keep gRPC servers from shutting down — track and
  // close them in afterAll hooks.
  openProxies.push(proxy);
  return (proxy as unknown as ClientGrpc).getService<AuthClient>(
    authProto.AUTH_SERVICE_NAME
  );
}

async function closeProxies(): Promise<void> {
  await Promise.all(openProxies.splice(0).map((proxy) => proxy.close()));
}

function call<T>(observable: Observable<T>): Promise<T> {
  return lastValueFrom(observable);
}

function bearer(token: string): Metadata {
  const metadata = new Metadata();
  metadata.add("authorization", token);
  return metadata;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 30_000,
  intervalMs = 250
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
  expect.unreachable("waitFor timed out");
}

async function expectGrpcCode(
  promise: Promise<unknown>,
  expected: status
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: number }).code).toBe(expected);
    return;
  }
  expect.unreachable(`expected gRPC error ${status[expected]}`);
}

function runMigrations(): void {
  // The prisma .bin shim has a `#!/usr/bin/env node` shebang — run the CLI
  // entry point through the current runtime so it works under Bun too.
  const local = path.join(
    APP_DIR,
    "node_modules",
    "prisma",
    "build",
    "index.js"
  );
  const root = path.join(
    APP_DIR,
    "..",
    "..",
    "node_modules",
    "prisma",
    "build",
    "index.js"
  );
  const prismaCli = [local, root].find(existsSync);
  const result = prismaCli
    ? spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
        cwd: APP_DIR,
        env: process.env,
        encoding: "utf8"
      })
    : spawnSync(process.execPath, ["x", "prisma", "migrate", "deploy"], {
        cwd: APP_DIR,
        env: process.env,
        encoding: "utf8"
      });
  if (result.status !== 0) {
    throw new Error(
      `prisma migrate deploy failed:\n${result.stdout}\n${result.stderr}`
    );
  }
}

interface CollectedEvent {
  eventType?: string;
  payload?: { userId?: string; userName?: string; role?: string };
  [key: string]: unknown;
}

async function startConsumer(events: CollectedEvent[]): Promise<Consumer> {
  const kafka = new Kafka({
    clientId: "auth-e2e",
    brokers: ["localhost:29092"]
  });
  const consumer = kafka.consumer({
    groupId: `auth-e2e-${randomUUID()}`
  });
  await consumer.connect();
  await consumer.subscribe({
    topic: KAFKA_TOPICS.authUserEvents,
    fromBeginning: true
  });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (message.value) {
        events.push(JSON.parse(message.value.toString()));
      }
    }
  });
  return consumer;
}

function eventForUser(
  events: CollectedEvent[],
  userName: string
): CollectedEvent | undefined {
  return events.find(
    (e) =>
      e.eventType === EVENT_TYPES.userRegistered &&
      e.payload?.userName === userName
  );
}

async function setBaseEnv(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    extractable: true
  });
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://auth_user:auth_pass@localhost:5432/auth_db",
    REDIS_URL: "redis://localhost:6379",
    KAFKA_BROKERS: "localhost:29092",
    JWT_PRIVATE_KEY: Buffer.from(
      await exportPKCS8(privateKey),
      "utf8"
    ).toString("base64"),
    JWT_PUBLIC_KEY: Buffer.from(await exportSPKI(publicKey), "utf8").toString(
      "base64"
    ),
    JWT_ACCESS_TTL_SEC: "300",
    JWT_REFRESH_TTL_SEC: "3600",
    SEED_ADMIN_USER_NAME: "admin",
    SEED_ADMIN_PASSWORD: "admin"
  });
}

async function startApp(port: number): Promise<INestMicroservice> {
  const { AppModule } = await import("../src/app.module");
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.GRPC,
      options: {
        package: GRPC_PACKAGE,
        protoPath: PROTO_PATH,
        url: `127.0.0.1:${port}`
      }
    }
  );
  await app.listen();
  return app;
}

describe("auth-service e2e (real postgres + redis + kafka)", () => {
  let app: INestMicroservice;
  let auth: AuthClient;
  let consumer: Consumer;
  const events: CollectedEvent[] = [];

  beforeAll(async () => {
    await setBaseEnv();
    runMigrations();
    app = await startApp(50051);
    auth = grpcClient("127.0.0.1:50051");
    consumer = await startConsumer(events);
  }, 90_000);

  afterAll(async () => {
    await closeProxies();
    await consumer?.disconnect();
    await app?.close();
  }, 30_000);

  it("register → validate → login → refresh → revoke → revoked tokens rejected", async () => {
    const userName = uniqueName();

    // Register: auto-login token pair
    const pair = await call(auth.register({ userName, password: PASSWORD }));
    expect(pair.accessToken).toBeTruthy();
    expect(pair.refreshToken).toBeTruthy();
    expect(pair.accessTokenExpiresIn).toBeGreaterThan(0);
    expect(pair.refreshTokenExpiresIn).toBeGreaterThan(0);

    // ValidateToken: valid=true + user context (CUSTOMER)
    const validation = await call(
      auth.validateToken({ accessToken: pair.accessToken })
    );
    expect(validation.valid).toBe(true);
    expect(validation.user?.userName).toBe(userName);
    expect(validation.user?.role).toBe(authProto.Role.ROLE_CUSTOMER);
    const userId = validation.user!.userId;

    // Login with the same credentials
    const login = await call(auth.login({ userName, password: PASSWORD }));
    expect(login.accessToken).toBeTruthy();

    // GetUser: own profile with own token
    const me = await call(auth.getUser({ userId }, bearer(pair.accessToken)));
    expect(me.userId).toBe(userId);
    expect(me.userName).toBe(userName);
    expect(me.role).toBe(authProto.Role.ROLE_CUSTOMER);

    // Refresh: rotation — new pair, old refresh token rejected on reuse
    const rotated = await call(
      auth.refresh({ refreshToken: pair.refreshToken })
    );
    expect(rotated.refreshToken).not.toBe(pair.refreshToken);
    await expectGrpcCode(
      call(auth.refresh({ refreshToken: pair.refreshToken })),
      status.UNAUTHENTICATED
    );

    // RevokeToken: refresh jti revoked in DB + access jti to Redis denylist
    await call(
      auth.revokeToken({
        refreshToken: rotated.refreshToken,
        accessToken: rotated.accessToken
      })
    );
    // idempotent second revoke succeeds
    await call(auth.revokeToken({ refreshToken: rotated.refreshToken }));

    // revoked access: ValidateToken → valid=false (denylist read)
    expect(
      (await call(auth.validateToken({ accessToken: rotated.accessToken })))
        .valid
    ).toBe(false);
    // revoked access: GetUser → UNAUTHENTICATED (denylist in the request path)
    await expectGrpcCode(
      call(auth.getUser({ userId }, bearer(rotated.accessToken))),
      status.UNAUTHENTICATED
    );
    // revoked refresh: Refresh → UNAUTHENTICATED
    await expectGrpcCode(
      call(auth.refresh({ refreshToken: rotated.refreshToken })),
      status.UNAUTHENTICATED
    );
  }, 60_000);

  it("rejects duplicate user_name with ALREADY_EXISTS", async () => {
    const userName = uniqueName();
    await call(auth.register({ userName, password: PASSWORD }));
    await expectGrpcCode(
      call(auth.register({ userName, password: PASSWORD })),
      status.ALREADY_EXISTS
    );
  });

  it("rejects a weak password with INVALID_ARGUMENT", async () => {
    await expectGrpcCode(
      call(auth.register({ userName: uniqueName(), password: "weak" })),
      status.INVALID_ARGUMENT
    );
  });

  it("rejects bad credentials with UNAUTHENTICATED", async () => {
    const userName = uniqueName();
    await call(auth.register({ userName, password: PASSWORD }));
    await expectGrpcCode(
      call(auth.login({ userName, password: "Wrong!234" })),
      status.UNAUTHENTICATED
    );
    await expectGrpcCode(
      call(auth.login({ userName: uniqueName(), password: PASSWORD })),
      status.UNAUTHENTICATED
    );
  });

  it("seeds the admin from SEED_ADMIN_* env and lets it login", async () => {
    const tokens = await call(
      auth.login({ userName: "admin", password: "admin" })
    );
    expect(tokens.accessToken).toBeTruthy();

    const validation = await call(
      auth.validateToken({ accessToken: tokens.accessToken })
    );
    expect(validation.valid).toBe(true);
    expect(validation.user?.role).toBe(authProto.Role.ROLE_ADMIN);
  });

  it("GetUser ownership: staff reads foreign, customer denied, anonymous unauthenticated", async () => {
    const userName = uniqueName();
    const pair = await call(auth.register({ userName, password: PASSWORD }));
    const me = await call(
      auth.validateToken({ accessToken: pair.accessToken })
    );
    const userId = me.user!.userId;

    // foreign profile as CUSTOMER → PERMISSION_DENIED
    const other = await call(
      auth.register({ userName: uniqueName(), password: PASSWORD })
    );
    await expectGrpcCode(
      call(auth.getUser({ userId }, bearer(other.accessToken))),
      status.PERMISSION_DENIED
    );

    // foreign profile as ADMIN (seed) → OK
    const admin = await call(
      auth.login({ userName: "admin", password: "admin" })
    );
    const asAdmin = await call(
      auth.getUser({ userId }, bearer(admin.accessToken))
    );
    expect(asAdmin.userName).toBe(userName);

    // missing user as ADMIN → NOT_FOUND
    await expectGrpcCode(
      call(auth.getUser({ userId: randomUUID() }, bearer(admin.accessToken))),
      status.NOT_FOUND
    );

    // no token at all → UNAUTHENTICATED
    await expectGrpcCode(
      call(auth.getUser({ userId })),
      status.UNAUTHENTICATED
    );
  }, 60_000);

  it("publishes auth.user.registered to Kafka via the outbox relay", async () => {
    const userName = uniqueName();
    await call(auth.register({ userName, password: PASSWORD }));

    await waitFor(() => eventForUser(events, userName) !== undefined);
    const event = eventForUser(events, userName)!;
    expect(event.payload?.userName).toBe(userName);
    expect(event.payload?.role).toBe("CUSTOMER");
    expect(event.payload?.userId).toBeTruthy();
  }, 60_000);
});

describe("outbox relay survives broker outage", () => {
  it("register succeeds with a dead broker; a later instance publishes the event", async () => {
    // Service instance pointed at an unreachable broker must still boot and
    // serve RPCs — the Kafka producer connects lazily / with retries.
    process.env.KAFKA_BROKERS = "localhost:1";
    const deadBrokerApp = await startApp(50061);
    const deadClient = grpcClient("127.0.0.1:50061");

    const userName = uniqueName();
    const pair = await call(
      deadClient.register({ userName, password: PASSWORD })
    );
    expect(pair.accessToken).toBeTruthy();
    await closeProxies();
    await deadBrokerApp.close();

    // "Broker comes back": a fresh instance with working brokers picks the
    // unpublished outbox row up (shared auth_db) and relays it.
    process.env.KAFKA_BROKERS = "localhost:29092";
    const recoveredApp = await startApp(50062);
    const events: CollectedEvent[] = [];
    const consumer = await startConsumer(events);
    try {
      await waitFor(() => eventForUser(events, userName) !== undefined);
      expect(eventForUser(events, userName)?.payload?.userName).toBe(userName);
    } finally {
      await consumer.disconnect();
      await recoveredApp.close();
    }
  }, 120_000);
});
