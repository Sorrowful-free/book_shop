import "reflect-metadata";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Metadata,
  Server,
  ServerCredentials,
  status,
  type sendUnaryData,
  type ServerUnaryCall,
  type ServiceDefinition,
  type ServiceError,
  type UntypedServiceImplementation
} from "@grpc/grpc-js";
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
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { lastValueFrom, type Observable } from "rxjs";
import {
  cartProto,
  catalogProto,
  EVENT_TYPES,
  KAFKA_TOPICS,
  orderProto,
  UserRole
} from "@book-shop/contracts";
import { ERROR_DETAILS_METADATA_KEY } from "../src/clients";
import { PrismaClient } from "../src/generated/prisma";

const APP_DIR = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  ".."
);
const PROTO_PATH = createRequire(import.meta.url).resolve(
  "@book-shop/contracts/proto/order.proto"
);
const GRPC_PACKAGE = orderProto.BOOKSHOP_ORDER_V1_PACKAGE_NAME;
const CART_ADDR = "127.0.0.1:50082";
const CATALOG_ADDR = "127.0.0.1:50083";
const DATABASE_URL =
  "postgresql://order_user:order_pass@localhost:5432/order_db";

type OrderClient = orderProto.OrderServiceClient;
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let signingKey: SigningKey;

const openProxies: { close(): unknown }[] = [];

function grpcClient(url: string): OrderClient {
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
  // close them in afterAll hooks / test teardown.
  openProxies.push(proxy);
  return (proxy as unknown as ClientGrpc).getService<OrderClient>(
    orderProto.ORDER_SERVICE_NAME
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
): Promise<ServiceError> {
  try {
    await promise;
  } catch (error) {
    const serviceError = error as ServiceError;
    expect(serviceError.code).toBe(expected);
    return serviceError;
  }
  expect.unreachable(`expected gRPC error ${status[expected]}`);
}

/** Structured details off the wire — `error-details` trailing metadata. */
function wireDetails(error: ServiceError): Record<string, unknown> | undefined {
  const raw = error.metadata?.get(ERROR_DETAILS_METADATA_KEY)[0];
  if (raw === undefined) {
    return undefined;
  }
  return JSON.parse(String(raw)) as Record<string, unknown>;
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

async function signToken(
  role: UserRole,
  userId = randomUUID()
): Promise<string> {
  // typ: "access" — JwtVerifier distinguishes access tokens from other
  // token types (e.g. refresh) via this claim.
  return new SignJWT({
    role,
    user_name: "e2e-tester",
    jti: randomUUID(),
    typ: "access"
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(signingKey);
}

async function setBaseEnv(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    extractable: true
  });
  signingKey = privateKey;
  Object.assign(process.env, {
    GRPC_PORT: "50054",
    DATABASE_URL,
    REDIS_URL: "redis://localhost:6379",
    KAFKA_BROKERS: "localhost:29092",
    JWT_PUBLIC_KEY: Buffer.from(await exportSPKI(publicKey), "utf8").toString(
      "base64"
    ),
    CART_GRPC_ADDR: CART_ADDR,
    CATALOG_GRPC_ADDR: CATALOG_ADDR
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
  try {
    await app.listen();
  } catch (error) {
    // Close whatever did start (onModuleInit runs during listen) so a failed
    // start doesn't leak the bound port into later files in this process.
    await app.close().catch(() => {});
    throw error;
  }
  return app;
}

// ---------------------------------------------------------------------------
// In-process gRPC stubs for cart/catalog (spec §10). Raw grpc-js servers
// using the generated *ServiceService descriptors + *ServiceServer handler
// types; every call's `authorization` metadata is captured for assertions.
// ---------------------------------------------------------------------------

interface StubError {
  code: status;
  message: string;
  details?: Record<string, unknown>;
}

interface StubCall {
  method: string;
  request: unknown;
  authorization?: string;
}

function stubError(error: StubError): ServiceError {
  const metadata = new Metadata();
  if (error.details) {
    // The wire channel for structured details — same convention the service
    // emits and reads (see ERROR_DETAILS_METADATA_KEY in src/clients.ts).
    metadata.set(ERROR_DETAILS_METADATA_KEY, JSON.stringify(error.details));
  }
  return Object.assign(new Error(error.message), {
    code: error.code,
    details: error.message,
    metadata,
    name: "ServiceError"
  }) as ServiceError;
}

function authorizationOf(metadata: Metadata): string | undefined {
  const value = metadata.get("authorization")[0];
  return value === undefined ? undefined : String(value);
}

function unimplementedStub<Req, Res>(
  _call: ServerUnaryCall<Req, Res>,
  callback: sendUnaryData<Res>
): void {
  callback(
    stubError({
      code: status.UNIMPLEMENTED,
      message: "not implemented in stub"
    }),
    null as never
  );
}

const cartStub = {
  calls: [] as StubCall[],
  items: [] as cartProto.CartItem[],
  error: undefined as StubError | undefined,
  reset() {
    this.calls = [];
    this.items = [];
    this.error = undefined;
  },
  callsOf(method: string) {
    return this.calls.filter((call) => call.method === method);
  }
};

const cartHandlers: cartProto.CartServiceServer = {
  createCart: unimplementedStub,
  getCart: (call, callback) => {
    cartStub.calls.push({
      method: "getCart",
      request: call.request,
      authorization: authorizationOf(call.metadata)
    });
    if (cartStub.error) {
      callback(stubError(cartStub.error), null as never);
      return;
    }
    callback(null, { items: cartStub.items });
  },
  addItem: unimplementedStub,
  updateItem: unimplementedStub,
  removeItem: unimplementedStub,
  clearCart: unimplementedStub,
  mergeCart: unimplementedStub
};

const catalogStub = {
  calls: [] as StubCall[],
  books: new Map<string, catalogProto.Book>(),
  getBooksError: undefined as StubError | undefined,
  reserveError: undefined as StubError | undefined,
  commitError: undefined as StubError | undefined,
  releaseError: undefined as StubError | undefined,
  nextReservationId: "res-e2e-1",
  reset() {
    this.calls = [];
    this.books = new Map();
    this.getBooksError = undefined;
    this.reserveError = undefined;
    this.commitError = undefined;
    this.releaseError = undefined;
    this.nextReservationId = "res-e2e-1";
  },
  callsOf(method: string) {
    return this.calls.filter((call) => call.method === method);
  }
};

function seedStubBook(
  overrides: Partial<catalogProto.Book> & { bookId: string }
): catalogProto.Book {
  const book: catalogProto.Book = {
    bookName: `Book ${overrides.bookId}`,
    author: "E2E Author",
    price: 10,
    stock: 0,
    available: 0,
    isDeleted: false,
    ...overrides
  };
  catalogStub.books.set(book.bookId, book);
  return book;
}

const catalogHandlers: catalogProto.CatalogServiceServer = {
  listBooks: unimplementedStub,
  searchBooks: unimplementedStub,
  getBook: unimplementedStub,
  getBooksByIds: (call, callback) => {
    catalogStub.calls.push({
      method: "getBooksByIds",
      request: call.request,
      authorization: authorizationOf(call.metadata)
    });
    if (catalogStub.getBooksError) {
      callback(stubError(catalogStub.getBooksError), null as never);
      return;
    }
    // Mirror the real service: every id must resolve — NOT_FOUND on a miss
    // with the failing ids in structured details (spec §2/F-C4 style).
    const missing = call.request.bookIds.filter(
      (id) => !catalogStub.books.has(id)
    );
    if (missing.length > 0) {
      callback(
        stubError({
          code: status.NOT_FOUND,
          message: `books not found: ${missing.join(", ")}`,
          details: { missingBookIds: missing }
        }),
        null as never
      );
      return;
    }
    callback(null, {
      books: call.request.bookIds.map((id) => catalogStub.books.get(id)!)
    });
  },
  createBook: unimplementedStub,
  updateBook: unimplementedStub,
  deleteBook: unimplementedStub,
  restoreBook: unimplementedStub,
  reserveStock: (call, callback) => {
    catalogStub.calls.push({
      method: "reserveStock",
      request: call.request,
      authorization: authorizationOf(call.metadata)
    });
    if (catalogStub.reserveError) {
      callback(stubError(catalogStub.reserveError), null as never);
      return;
    }
    callback(null, {
      reservationId: catalogStub.nextReservationId
    });
  },
  commitStock: (call, callback) => {
    catalogStub.calls.push({
      method: "commitStock",
      request: call.request,
      authorization: authorizationOf(call.metadata)
    });
    if (catalogStub.commitError) {
      callback(stubError(catalogStub.commitError), null as never);
      return;
    }
    callback(null, {});
  },
  releaseStock: (call, callback) => {
    catalogStub.calls.push({
      method: "releaseStock",
      request: call.request,
      authorization: authorizationOf(call.metadata)
    });
    if (catalogStub.releaseError) {
      callback(stubError(catalogStub.releaseError), null as never);
      return;
    }
    callback(null, {});
  }
};

function startStubServer(
  service: unknown,
  handlers: UntypedServiceImplementation,
  addr: string
): Promise<Server> {
  const server = new Server();
  server.addService(
    service as ServiceDefinition<UntypedServiceImplementation>,
    handlers
  );
  return new Promise((resolve, reject) => {
    server.bindAsync(addr, ServerCredentials.createInsecure(), (error) =>
      error ? reject(error) : resolve(server)
    );
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface CollectedEvent {
  eventType?: string;
  payload?: {
    orderId?: string;
    userId?: string;
    totalPrice?: number;
    goods?: { bookId: string }[];
  };
}

async function startConsumer(events: CollectedEvent[]): Promise<Consumer> {
  const kafka = new Kafka({
    clientId: "order-e2e",
    brokers: ["localhost:29092"]
  });
  const consumer = kafka.consumer({
    groupId: `order-e2e-${randomUUID()}`
  });
  await consumer.connect();
  await consumer.subscribe({
    topic: KAFKA_TOPICS.orderOrderEvents,
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

function eventFor(
  events: CollectedEvent[],
  eventType: string,
  orderId: string
): CollectedEvent | undefined {
  return events.find(
    (e) => e.eventType === eventType && e.payload?.orderId === orderId
  );
}

function stubBook(bookId: string, price: number): catalogProto.Book {
  return seedStubBook({ bookId, price });
}

/** A PENDING order row straight into order_db — the checkout-free fixture
 * for pay/cancel/get tests (the stub decides what the reservation does). */
async function seedOrderRow(overrides: {
  userId: string;
  status?: "PENDING" | "PAID" | "CANCELLED";
  reservationId?: string | null;
}): Promise<string> {
  const prisma = new PrismaClient();
  try {
    const order = await prisma.order.create({
      data: {
        userId: overrides.userId,
        status: overrides.status ?? "PENDING",
        reservationId:
          overrides.reservationId === undefined
            ? `res-${randomUUID().slice(0, 8)}`
            : overrides.reservationId,
        idempotencyKey: randomUUID(),
        totalPrice: 20,
        items: {
          create: [
            {
              bookId: "b-1",
              bookName: "Fixture Book",
              author: "Fixture Author",
              price: 10,
              amount: 2
            }
          ]
        }
      }
    });
    return order.id;
  } finally {
    await prisma.$disconnect();
  }
}

// ---------------------------------------------------------------------------
// e2e suite
// ---------------------------------------------------------------------------

// Shared lifecycle for every describe below: the cart/catalog stub servers
// and the primary service instance live for the whole file — later
// describes spawn EXTRA app instances with mutated env against the same
// stubs and infra.
let app: INestMicroservice;
let orders: OrderClient;
let consumer: Consumer;
let cartServer: Server;
let catalogServer: Server;
const events: CollectedEvent[] = [];

beforeAll(async () => {
  await setBaseEnv();
  runMigrations();
  // Clean slate: earlier runs leave orders behind. RESTART IDENTITY
  // CASCADE keeps the truncate working when a table not listed here gains
  // an FK onto any of these (outbox has none today).
  const prisma = new PrismaClient();
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "order_items", "orders", "outbox" RESTART IDENTITY CASCADE'
  );
  await prisma.$disconnect();
  cartServer = await startStubServer(
    cartProto.CartServiceService,
    cartHandlers,
    CART_ADDR
  );
  catalogServer = await startStubServer(
    catalogProto.CatalogServiceService,
    catalogHandlers,
    CATALOG_ADDR
  );
  app = await startApp(50054);
  orders = grpcClient("127.0.0.1:50054");
  consumer = await startConsumer(events);
}, 90_000);

afterAll(async () => {
  await closeProxies();
  await consumer?.disconnect();
  await app?.close();
  cartServer?.forceShutdown();
  catalogServer?.forceShutdown();
}, 30_000);

describe("order-service e2e (real postgres + kafka + redis, stubbed deps)", () => {
  beforeEach(() => {
    cartStub.reset();
    catalogStub.reset();
  });

  it("Checkout returns a PENDING order snapshot, forwards authorization, delivers order.order.created", async () => {
    const userId = randomUUID();
    const token = await signToken(UserRole.Customer, userId);
    const b1 = stubBook("b-1", 12.5);
    const b2 = stubBook("b-2", 7.25);
    cartStub.items = [
      { bookId: b2.bookId, amount: 4 },
      { bookId: b1.bookId, amount: 2 }
    ];

    const order = await call(
      orders.checkout({ idempotencyKey: randomUUID() }, bearer(token))
    );

    expect(order.orderId).toBeTruthy();
    expect(order.userId).toBe(userId);
    expect(order.status).toBe(orderProto.OrderStatus.ORDER_STATUS_PENDING);
    // Snapshot order is deterministic — book_id ASC (F-O5).
    expect(order.items.map((item) => item.bookId)).toEqual(["b-1", "b-2"]);
    expect(order.items[0]).toMatchObject({
      bookName: b1.bookName,
      author: b1.author,
      price: 12.5,
      amount: 2
    });
    expect(order.totalPrice).toBe(54);
    expect(order.createdAt?.seconds).toBeGreaterThan(0);

    // The caller's authorization was propagated verbatim to every dep call.
    for (const depCall of [...cartStub.calls, ...catalogStub.calls]) {
      expect(depCall.authorization).toBe(token);
    }
    expect(catalogStub.callsOf("reserveStock")).toHaveLength(1);

    // outbox → kafka delivery
    await waitFor(
      () =>
        eventFor(events, EVENT_TYPES.orderCreated, order.orderId) !== undefined
    );
    const event = eventFor(events, EVENT_TYPES.orderCreated, order.orderId)!;
    expect(event.payload?.userId).toBe(userId);
    expect(event.payload?.totalPrice).toBe(54);
  }, 60_000);

  it("a repeated Checkout with the same key returns the same order without a new saga", async () => {
    const token = await signToken(UserRole.Customer);
    stubBook("b-1", 10);
    cartStub.items = [{ bookId: "b-1", amount: 1 }];
    const key = randomUUID();

    const first = await call(
      orders.checkout({ idempotencyKey: key }, bearer(token))
    );
    const second = await call(
      orders.checkout({ idempotencyKey: key }, bearer(token))
    );

    expect(second.orderId).toBe(first.orderId);
    expect(cartStub.callsOf("getCart")).toHaveLength(1);
    expect(catalogStub.callsOf("getBooksByIds")).toHaveLength(1);
    expect(catalogStub.callsOf("reserveStock")).toHaveLength(1);
  }, 60_000);

  it("two parallel checkouts with one key resolve to a single order", async () => {
    const token = await signToken(UserRole.Customer);
    stubBook("b-1", 10);
    cartStub.items = [{ bookId: "b-1", amount: 1 }];
    const key = randomUUID();

    const [a, b] = await Promise.all([
      call(orders.checkout({ idempotencyKey: key }, bearer(token))),
      call(orders.checkout({ idempotencyKey: key }, bearer(token)))
    ]);
    expect(a.orderId).toBe(b.orderId);
    // Whichever path the loser took (pre-check or unique violation), exactly
    // one order exists for the key.
    const prisma = new PrismaClient();
    try {
      const count = await prisma.order.count({
        where: { idempotencyKey: key }
      });
      expect(count).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  }, 60_000);

  it("rejects an empty cart with FAILED_PRECONDITION before reserving", async () => {
    const token = await signToken(UserRole.Customer);
    cartStub.items = [];
    await expectGrpcCode(
      call(orders.checkout({ idempotencyKey: randomUUID() }, bearer(token))),
      status.FAILED_PRECONDITION
    );
    expect(catalogStub.calls).toHaveLength(0);
  }, 60_000);

  it("rejects a malformed idempotency_key with INVALID_ARGUMENT", async () => {
    const token = await signToken(UserRole.Customer);
    await expectGrpcCode(
      call(orders.checkout({ idempotencyKey: "not-a-uuid" }, bearer(token))),
      status.INVALID_ARGUMENT
    );
    expect(cartStub.calls).toHaveLength(0);
  }, 60_000);

  it("passes catalog's NOT_FOUND + missingBookIds through to the caller (F-O4)", async () => {
    const token = await signToken(UserRole.Customer);
    cartStub.items = [{ bookId: "b-gone", amount: 1 }];

    const error = await expectGrpcCode(
      call(orders.checkout({ idempotencyKey: randomUUID() }, bearer(token))),
      status.NOT_FOUND
    );
    expect(wireDetails(error)?.missingBookIds).toEqual(["b-gone"]);
    expect(catalogStub.callsOf("reserveStock")).toHaveLength(0);
  }, 60_000);

  it("passes ReserveStock FAILED_PRECONDITION + unavailableBookIds through (F-O4)", async () => {
    const token = await signToken(UserRole.Customer);
    stubBook("b-1", 10);
    cartStub.items = [{ bookId: "b-1", amount: 99 }];
    catalogStub.reserveError = {
      code: status.FAILED_PRECONDITION,
      message: "books unavailable for reservation: b-1",
      details: { unavailableBookIds: ["b-1"] }
    };

    const error = await expectGrpcCode(
      call(orders.checkout({ idempotencyKey: randomUUID() }, bearer(token))),
      status.FAILED_PRECONDITION
    );
    expect(wireDetails(error)?.unavailableBookIds).toEqual(["b-1"]);
  }, 60_000);

  it("PayOrder commits the reservation, emits order.paid and is idempotent on PAID (F-O3)", async () => {
    const userId = randomUUID();
    const token = await signToken(UserRole.Customer, userId);
    const orderId = await seedOrderRow({ userId });

    const paid = await call(orders.payOrder({ orderId }, bearer(token)));
    expect(paid.status).toBe(orderProto.OrderStatus.ORDER_STATUS_PAID);
    expect(paid.paidAt?.seconds).toBeGreaterThan(0);
    expect(catalogStub.callsOf("commitStock")).toHaveLength(1);

    await waitFor(
      () => eventFor(events, EVENT_TYPES.orderPaid, orderId) !== undefined
    );
    expect(
      eventFor(events, EVENT_TYPES.orderPaid, orderId)?.payload?.userId
    ).toBe(userId);

    // F-O3: the retry returns the same PAID order without a second commit.
    catalogStub.calls = [];
    const again = await call(orders.payOrder({ orderId }, bearer(token)));
    expect(again.status).toBe(orderProto.OrderStatus.ORDER_STATUS_PAID);
    expect(catalogStub.callsOf("commitStock")).toHaveLength(0);
  }, 60_000);

  it("PayOrder on an expired reservation cancels the order and emits order.cancelled", async () => {
    const userId = randomUUID();
    const token = await signToken(UserRole.Customer, userId);
    const orderId = await seedOrderRow({ userId });
    catalogStub.commitError = {
      code: status.NOT_FOUND,
      message: "reservation not found or expired"
    };

    await expectGrpcCode(
      call(orders.payOrder({ orderId }, bearer(token))),
      status.FAILED_PRECONDITION
    );
    await waitFor(
      () => eventFor(events, EVENT_TYPES.orderCancelled, orderId) !== undefined
    );

    const fetched = await call(orders.getOrder({ orderId }, bearer(token)));
    expect(fetched.status).toBe(orderProto.OrderStatus.ORDER_STATUS_CANCELLED);
    expect(fetched.cancelledAt?.seconds).toBeGreaterThan(0);
  }, 60_000);

  it("F-O1: CommitStock FAILED_PRECONDITION cancels the order, releases once and emits order.cancelled", async () => {
    const userId = randomUUID();
    const token = await signToken(UserRole.Customer, userId);
    const orderId = await seedOrderRow({ userId });
    catalogStub.commitError = {
      code: status.FAILED_PRECONDITION,
      message: "stock no longer covers the reserved amount"
    };

    await expectGrpcCode(
      call(orders.payOrder({ orderId }, bearer(token))),
      status.FAILED_PRECONDITION
    );
    expect(catalogStub.callsOf("releaseStock")).toHaveLength(1);
    await waitFor(
      () => eventFor(events, EVENT_TYPES.orderCancelled, orderId) !== undefined
    );
    const fetched = await call(orders.getOrder({ orderId }, bearer(token)));
    expect(fetched.status).toBe(orderProto.OrderStatus.ORDER_STATUS_CANCELLED);
  }, 60_000);

  it("CancelOrder releases the reservation and emits order.cancelled; a repeat is FAILED_PRECONDITION", async () => {
    const userId = randomUUID();
    const token = await signToken(UserRole.Customer, userId);
    const orderId = await seedOrderRow({ userId });

    const cancelled = await call(
      orders.cancelOrder({ orderId }, bearer(token))
    );
    expect(cancelled.status).toBe(
      orderProto.OrderStatus.ORDER_STATUS_CANCELLED
    );
    expect(cancelled.cancelledAt?.seconds).toBeGreaterThan(0);
    expect(catalogStub.callsOf("releaseStock")).toHaveLength(1);

    await waitFor(
      () => eventFor(events, EVENT_TYPES.orderCancelled, orderId) !== undefined
    );

    await expectGrpcCode(
      call(orders.cancelOrder({ orderId }, bearer(token))),
      status.FAILED_PRECONDITION
    );
    await expectGrpcCode(
      call(orders.payOrder({ orderId }, bearer(token))),
      status.FAILED_PRECONDITION
    );
  }, 60_000);

  it("CancelOrder self-heals to PAID when the reservation is already COMMITTED (F-O2)", async () => {
    const userId = randomUUID();
    const token = await signToken(UserRole.Customer, userId);
    const orderId = await seedOrderRow({ userId });
    catalogStub.releaseError = {
      code: status.FAILED_PRECONDITION,
      message: "reservation cannot be released",
      details: { reservationStatus: "COMMITTED" }
    };

    const healed = await call(orders.cancelOrder({ orderId }, bearer(token)));
    expect(healed.status).toBe(orderProto.OrderStatus.ORDER_STATUS_PAID);
    await waitFor(
      () => eventFor(events, EVENT_TYPES.orderPaid, orderId) !== undefined
    );
    expect(
      eventFor(events, EVENT_TYPES.orderCancelled, orderId)
    ).toBeUndefined();
  }, 60_000);

  it("CancelOrder cancels when the reservation is already RELEASED (F-O2)", async () => {
    const userId = randomUUID();
    const token = await signToken(UserRole.Customer, userId);
    const orderId = await seedOrderRow({ userId });
    catalogStub.releaseError = {
      code: status.FAILED_PRECONDITION,
      message: "reservation cannot be released",
      details: { reservationStatus: "RELEASED" }
    };

    const cancelled = await call(
      orders.cancelOrder({ orderId }, bearer(token))
    );
    expect(cancelled.status).toBe(
      orderProto.OrderStatus.ORDER_STATUS_CANCELLED
    );
    await waitFor(
      () => eventFor(events, EVENT_TYPES.orderCancelled, orderId) !== undefined
    );
  }, 60_000);

  it("CancelOrder cancels when the reservation is already gone (NOT_FOUND)", async () => {
    const userId = randomUUID();
    const token = await signToken(UserRole.Customer, userId);
    const orderId = await seedOrderRow({ userId });
    catalogStub.releaseError = {
      code: status.NOT_FOUND,
      message: "reservation not found or expired"
    };

    const cancelled = await call(
      orders.cancelOrder({ orderId }, bearer(token))
    );
    expect(cancelled.status).toBe(
      orderProto.OrderStatus.ORDER_STATUS_CANCELLED
    );
  }, 60_000);

  it("enforces ownership and authentication on GetOrder/PayOrder/CancelOrder", async () => {
    const ownerId = randomUUID();
    const owner = bearer(await signToken(UserRole.Customer, ownerId));
    const stranger = bearer(await signToken(UserRole.Customer));
    const admin = bearer(await signToken(UserRole.Admin));
    const orderId = await seedOrderRow({ userId: ownerId });

    // Owner, ADMIN, EMPLOYER may read; a stranger may not.
    const fetched = await call(orders.getOrder({ orderId }, owner));
    expect(fetched.orderId).toBe(orderId);
    await call(orders.getOrder({ orderId }, admin));
    await call(
      orders.getOrder({ orderId }, bearer(await signToken(UserRole.Employer)))
    );
    await expectGrpcCode(
      call(orders.getOrder({ orderId }, stranger)),
      status.PERMISSION_DENIED
    );
    await expectGrpcCode(
      call(orders.getOrder({ orderId: randomUUID() }, owner)),
      status.NOT_FOUND
    );
    await expectGrpcCode(
      call(orders.getOrder({ orderId }, new Metadata())),
      status.UNAUTHENTICATED
    );
    await expectGrpcCode(
      call(orders.checkout({ idempotencyKey: randomUUID() }, new Metadata())),
      status.UNAUTHENTICATED
    );

    // A stranger cannot pay or cancel someone else's order either.
    await expectGrpcCode(
      call(orders.payOrder({ orderId }, stranger)),
      status.PERMISSION_DENIED
    );
    await expectGrpcCode(
      call(orders.cancelOrder({ orderId }, stranger)),
      status.PERMISSION_DENIED
    );
  }, 60_000);

  it("ListMyOrders returns own orders newest-first with items book_id ASC; bounds are validated", async () => {
    const userId = randomUUID();
    const token = bearer(await signToken(UserRole.Customer, userId));
    // Two checkouts — the second lands newer in the list.
    stubBook("b-a", 5);
    stubBook("b-b", 7);
    cartStub.items = [{ bookId: "b-a", amount: 1 }];
    const first = await call(
      orders.checkout({ idempotencyKey: randomUUID() }, token)
    );
    cartStub.items = [
      { bookId: "b-b", amount: 1 },
      { bookId: "b-a", amount: 1 }
    ];
    const second = await call(
      orders.checkout({ idempotencyKey: randomUUID() }, token)
    );
    await seedOrderRow({ userId: "someone-else" });

    const page = await call(
      orders.listMyOrders({ offset: 0, limit: 10 }, token)
    );
    expect(page.total).toBe(2);
    // F-O5: created_at DESC — the second checkout leads.
    expect(page.orders[0]?.orderId).toBe(second.orderId);
    expect(page.orders[1]?.orderId).toBe(first.orderId);
    // F-O5: items book_id ASC.
    expect(page.orders[0]?.items.map((item) => item.bookId)).toEqual([
      "b-a",
      "b-b"
    ]);

    await expectGrpcCode(
      call(orders.listMyOrders({ offset: 0, limit: 101 }, token)),
      status.INVALID_ARGUMENT
    );
    await expectGrpcCode(
      call(orders.listMyOrders({ offset: 0, limit: 10 }, new Metadata())),
      status.UNAUTHENTICATED
    );
  }, 90_000);
});

describe("dependency outage behavior", () => {
  beforeEach(() => {
    cartStub.reset();
    catalogStub.reset();
  });

  it("a dead catalog-service surfaces UNAVAILABLE on checkout", async () => {
    await setBaseEnv();
    process.env.CATALOG_GRPC_ADDR = "127.0.0.1:1"; // nothing listens there
    const deadDepApp = await startApp(50064);
    const deadClient = grpcClient("127.0.0.1:50064");
    try {
      const token = await signToken(UserRole.Customer);
      cartStub.items = [{ bookId: "b-1", amount: 1 }];
      await expectGrpcCode(
        call(
          deadClient.checkout({ idempotencyKey: randomUUID() }, bearer(token))
        ),
        status.UNAVAILABLE
      );
    } finally {
      await closeProxies();
      await deadDepApp.close();
      process.env.CATALOG_GRPC_ADDR = CATALOG_ADDR;
    }
  }, 90_000);

  it("a dead cart-service surfaces UNAVAILABLE on checkout", async () => {
    process.env.CART_GRPC_ADDR = "127.0.0.1:1";
    const deadDepApp = await startApp(50065);
    const deadClient = grpcClient("127.0.0.1:50065");
    try {
      const token = await signToken(UserRole.Customer);
      await expectGrpcCode(
        call(
          deadClient.checkout({ idempotencyKey: randomUUID() }, bearer(token))
        ),
        status.UNAVAILABLE
      );
    } finally {
      await closeProxies();
      await deadDepApp.close();
      process.env.CART_GRPC_ADDR = CART_ADDR;
    }
  }, 90_000);
});

describe("outbox relay survives broker outage", () => {
  beforeEach(() => {
    cartStub.reset();
    catalogStub.reset();
  });

  it("Checkout succeeds with a dead broker; a later instance publishes order.order.created", async () => {
    await setBaseEnv();
    process.env.KAFKA_BROKERS = "localhost:1";
    const deadBrokerApp = await startApp(50066);
    const deadClient = grpcClient("127.0.0.1:50066");

    const token = await signToken(UserRole.Customer);
    stubBook("b-1", 10);
    cartStub.items = [{ bookId: "b-1", amount: 1 }];

    const order = await call(
      deadClient.checkout({ idempotencyKey: randomUUID() }, bearer(token))
    );
    await closeProxies();
    await deadBrokerApp.close();

    // "Broker comes back": a fresh instance with working brokers picks the
    // unpublished outbox row up (shared order_db) and relays it.
    process.env.KAFKA_BROKERS = "localhost:29092";
    const recoveredApp = await startApp(50067);
    const events: CollectedEvent[] = [];
    const consumer = await startConsumer(events);
    try {
      await waitFor(
        () =>
          eventFor(events, EVENT_TYPES.orderCreated, order.orderId) !==
          undefined,
        60_000
      );
      expect(
        eventFor(events, EVENT_TYPES.orderCreated, order.orderId)?.payload
          ?.orderId
      ).toBe(order.orderId);
    } finally {
      await consumer.disconnect();
      await recoveredApp.close();
    }
  }, 120_000);
});
