import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Metadata, status } from "@grpc/grpc-js";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientProxyFactory,
  Transport,
  type ClientGrpc,
  type MicroserviceOptions
} from "@nestjs/microservices";
import { Redis } from "ioredis";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { Kafka, type Producer } from "kafkajs";
import { lastValueFrom, type Observable } from "rxjs";
import {
  cartProto,
  EVENT_TYPES,
  KAFKA_TOPICS,
  type OrderCreatedPayload
} from "@book-shop/contracts";

const PROTO_PATH = createRequire(import.meta.url).resolve(
  "@book-shop/contracts/proto/cart.proto"
);
const GRPC_PACKAGE = cartProto.BOOKSHOP_CART_V1_PACKAGE_NAME;
const REDIS_URL = "redis://localhost:6379";
const KAFKA_BROKERS = "localhost:29092";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CartClient = cartProto.CartServiceClient;

let jwtSigningKey: CryptoKey;

async function signToken(userId: string, jti = randomUUID()): Promise<string> {
  return new SignJWT({ user_name: "e2e_user", role: "CUSTOMER" })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(jwtSigningKey);
}

function grpcClient(url: string): CartClient {
  const client = ClientProxyFactory.create({
    transport: Transport.GRPC,
    options: {
      package: GRPC_PACKAGE,
      protoPath: PROTO_PATH,
      url,
      loader: { keepCase: false, longs: Number, defaults: true }
    }
  }) as ClientGrpc;
  return client.getService<CartClient>(cartProto.CART_SERVICE_NAME);
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
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 250
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch {
      // service not ready yet — keep polling
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

async function startApp(port: number): Promise<INestApplication> {
  const { AppModule } = await import("../src/app.module");
  // Hybrid app: gRPC server + Kafka consumer (`order.order.events`,
  // group `cart-service`) in one process — spec §4.
  const app = await NestFactory.create(AppModule);
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: GRPC_PACKAGE,
      protoPath: PROTO_PATH,
      url: `127.0.0.1:${port}`
    }
  });
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: "cart-service",
        brokers: (process.env.KAFKA_BROKERS ?? KAFKA_BROKERS).split(",")
      },
      consumer: { groupId: "cart-service" }
    }
  });
  await app.startAllMicroservices();
  await app.init();
  return app;
}

async function setBaseEnv(cartTtlSec: string): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    extractable: true
  });
  jwtSigningKey = privateKey;
  Object.assign(process.env, {
    GRPC_PORT: "50053",
    REDIS_URL,
    KAFKA_BROKERS,
    CART_TTL_SEC: cartTtlSec,
    JWT_PUBLIC_KEY: Buffer.from(await exportSPKI(publicKey), "utf8").toString(
      "base64"
    )
  });
}

describe("cart-service e2e (real redis + kafka)", () => {
  let app: INestApplication;
  let cart: CartClient;
  let redis: Redis;
  let producer: Producer;

  beforeAll(async () => {
    await setBaseEnv("3600");
    app = await startApp(50053);
    cart = grpcClient("127.0.0.1:50053");
    redis = new Redis(REDIS_URL);
    const kafka = new Kafka({ clientId: "cart-e2e", brokers: [KAFKA_BROKERS] });
    producer = kafka.producer();
    await producer.connect();
  }, 60_000);

  afterAll(async () => {
    await producer?.disconnect();
    redis?.disconnect();
    await app?.close();
  });

  it("guest lifecycle: create → get → add → sum → update → remove → clear", async () => {
    const { cartId } = await call(cart.createCart({}));
    expect(cartId).toMatch(UUID_RE);

    let c = await call(cart.getCart({ cartId }));
    expect(c.items).toEqual([]);
    expect(c.expiresAt).toBeFalsy();

    c = await call(cart.addItem({ cartId, bookId: "book-1", amount: 2 }));
    expect(c.items).toEqual([{ bookId: "book-1", amount: 2 }]);

    // repeated add sums the amount
    c = await call(cart.addItem({ cartId, bookId: "book-1", amount: 3 }));
    expect(c.items).toEqual([{ bookId: "book-1", amount: 5 }]);

    // update is absolute
    c = await call(cart.updateItem({ cartId, bookId: "book-1", amount: 7 }));
    expect(c.items).toEqual([{ bookId: "book-1", amount: 7 }]);
    expect(c.expiresAt).toBeTruthy();
    expect(c.expiresAt!.seconds).toBeGreaterThan(
      Math.floor(Date.now() / 1000) + 3500
    );

    // missing position → NOT_FOUND; amount=0 removes
    await expectGrpcCode(
      call(cart.updateItem({ cartId, bookId: "book-x", amount: 1 })),
      status.NOT_FOUND
    );
    c = await call(cart.updateItem({ cartId, bookId: "book-1", amount: 0 }));
    expect(c.items).toEqual([]);

    await call(cart.addItem({ cartId, bookId: "book-2", amount: 1 }));
    c = await call(cart.removeItem({ cartId, bookId: "book-2" }));
    expect(c.items).toEqual([]);
    await expectGrpcCode(
      call(cart.removeItem({ cartId, bookId: "book-2" })),
      status.NOT_FOUND
    );

    await call(cart.addItem({ cartId, bookId: "book-9", amount: 4 }));
    await call(cart.clearCart({ cartId }));
    c = await call(cart.getCart({ cartId }));
    expect(c.items).toEqual([]);
    // ClearCart is idempotent
    await call(cart.clearCart({ cartId }));
  }, 60_000);

  it("rejects malformed input with INVALID_ARGUMENT", async () => {
    const { cartId } = await call(cart.createCart({}));
    await expectGrpcCode(
      call(cart.getCart({ cartId: "not-a-uuid" })),
      status.INVALID_ARGUMENT
    );
    await expectGrpcCode(
      call(cart.addItem({ cartId, bookId: "b", amount: 0 })),
      status.INVALID_ARGUMENT
    );
    await expectGrpcCode(
      call(cart.updateItem({ cartId, bookId: "b", amount: -1 })),
      status.INVALID_ARGUMENT
    );
  });

  it("user cart is addressed by JWT sub and isolated from guest carts", async () => {
    const userId = `e2e-${randomUUID()}`;
    const token = await signToken(userId);

    // no cart_id and no token → UNAUTHENTICATED; garbage token too
    await expectGrpcCode(call(cart.getCart({})), status.UNAUTHENTICATED);
    await expectGrpcCode(
      call(cart.getCart({}, bearer("garbage-token"))),
      status.UNAUTHENTICATED
    );

    let c = await call(
      cart.addItem({ bookId: "book-1", amount: 1 }, bearer(token))
    );
    expect(c.items).toEqual([{ bookId: "book-1", amount: 1 }]);

    // a guest cart stays fully separate from the user cart
    const { cartId } = await call(cart.createCart({}));
    await call(cart.addItem({ cartId, bookId: "book-9", amount: 9 }));

    c = await call(cart.getCart({}, bearer(token)));
    expect(c.items).toEqual([{ bookId: "book-1", amount: 1 }]);
    c = await call(cart.getCart({ cartId }));
    expect(c.items).toEqual([{ bookId: "book-9", amount: 9 }]);
  });

  it("rejects a revoked access token (denylist on the same Redis)", async () => {
    const jti = randomUUID();
    const token = await signToken(`revoked-${randomUUID()}`, jti);
    // RedisTokenDenylist reads `auth:revoked:{jti}` — same REDIS_URL as carts
    await redis.set(`auth:revoked:${jti}`, "1");
    await expectGrpcCode(
      call(cart.getCart({}, bearer(token))),
      status.UNAUTHENTICATED
    );
    await redis.del(`auth:revoked:${jti}`);
  });

  it("mergeCart sums guest items into the user cart and deletes the guest cart", async () => {
    const token = await signToken(`merge-${randomUUID()}`);
    const { cartId } = await call(cart.createCart({}));
    await call(cart.addItem({ cartId, bookId: "book-1", amount: 2 }));
    await call(cart.addItem({ cartId, bookId: "book-2", amount: 3 }));
    await call(cart.addItem({ bookId: "book-1", amount: 1 }, bearer(token)));

    const merged = await call(
      cart.mergeCart({ guestCartId: cartId }, bearer(token))
    );
    expect(merged.items).toHaveLength(2);
    expect(merged.items).toContainEqual({ bookId: "book-1", amount: 3 });
    expect(merged.items).toContainEqual({ bookId: "book-2", amount: 3 });

    // guest cart is deleted; user cart keeps the merged positions
    const guest = await call(cart.getCart({ cartId }));
    expect(guest.items).toEqual([]);

    // missing guest_cart_id → no-op success
    const again = await call(
      cart.mergeCart({ guestCartId: randomUUID() }, bearer(token))
    );
    expect(again.items).toHaveLength(2);
  });

  it("mergeCart requires a JWT — guest_cart_id is not an owner selector", async () => {
    const { cartId } = await call(cart.createCart({}));
    await call(cart.addItem({ cartId, bookId: "book-1", amount: 1 }));
    await expectGrpcCode(
      call(cart.mergeCart({ guestCartId: cartId })),
      status.UNAUTHENTICATED
    );
    // guest cart not consumed by the failed merge
    const guest = await call(cart.getCart({ cartId }));
    expect(guest.items).toEqual([{ bookId: "book-1", amount: 1 }]);
  });

  it("clears the user cart when order.order.created is published", async () => {
    const userId = `order-${randomUUID()}`;
    const token = await signToken(userId);
    await call(cart.addItem({ bookId: "book-1", amount: 1 }, bearer(token)));

    const payload: OrderCreatedPayload = {
      orderId: randomUUID(),
      userId,
      goods: [],
      totalPrice: 0
    };
    await producer.send({
      topic: KAFKA_TOPICS.orderOrderEvents,
      messages: [
        {
          key: userId,
          value: JSON.stringify({
            eventId: randomUUID(),
            eventType: EVENT_TYPES.orderCreated,
            occurredAt: new Date().toISOString(),
            payload
          })
        }
      ]
    });

    await waitFor(async () => {
      const c = await call(cart.getCart({}, bearer(token)));
      return c.items.length === 0;
    });
  }, 60_000);
});

describe("cart TTL (CART_TTL_SEC=1)", () => {
  let app: INestApplication;
  let cart: CartClient;

  beforeAll(async () => {
    process.env.CART_TTL_SEC = "1";
    app = await startApp(50063);
    cart = grpcClient("127.0.0.1:50063");
  }, 60_000);

  afterAll(async () => {
    process.env.CART_TTL_SEC = "3600";
    await app?.close();
  });

  it("the cart expires after CART_TTL_SEC without access", async () => {
    const { cartId } = await call(cart.createCart({}));
    await call(cart.addItem({ cartId, bookId: "book-1", amount: 1 }));
    await sleep(1600);
    const c = await call(cart.getCart({ cartId }));
    expect(c.items).toEqual([]);
    expect(c.expiresAt).toBeFalsy();
  }, 30_000);

  it("renews the TTL on every access (sliding expiration)", async () => {
    const { cartId } = await call(cart.createCart({}));
    await call(cart.addItem({ cartId, bookId: "book-1", amount: 1 }));

    // ~1.2s of periodic access — outlives the original 1s deadline
    for (let i = 0; i < 3; i++) {
      await sleep(400);
      const c = await call(cart.getCart({ cartId }));
      expect(c.items).toHaveLength(1);
    }

    // left alone, it still expires
    await sleep(1700);
    const expired = await call(cart.getCart({ cartId }));
    expect(expired.items).toEqual([]);
  }, 30_000);
});
