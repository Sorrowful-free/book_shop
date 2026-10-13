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
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { lastValueFrom, type Observable } from "rxjs";
import {
  catalogProto,
  EVENT_TYPES,
  KAFKA_TOPICS,
  UserRole
} from "@book-shop/contracts";
import { PrismaClient } from "../src/generated/prisma";

const APP_DIR = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  ".."
);
const PROTO_PATH = createRequire(import.meta.url).resolve(
  "@book-shop/contracts/proto/catalog.proto"
);
const GRPC_PACKAGE = catalogProto.BOOKSHOP_CATALOG_V1_PACKAGE_NAME;
const uniqueIsbn = () => `isbn-${randomUUID()}`;
const uniqueName = () =>
  `Book ${randomUUID().replaceAll("-", "").slice(0, 12)}`;

type CatalogClient = catalogProto.CatalogServiceClient;
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let signingKey: SigningKey;

const openProxies: { close(): unknown }[] = [];

function grpcClient(url: string): CatalogClient {
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
  return (proxy as unknown as ClientGrpc).getService<CatalogClient>(
    catalogProto.CATALOG_SERVICE_NAME
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
  payload?: {
    bookId?: string;
    bookName?: string;
    author?: string;
    price?: number;
  };
  [key: string]: unknown;
}

async function startConsumer(events: CollectedEvent[]): Promise<Consumer> {
  const kafka = new Kafka({
    clientId: "catalog-e2e",
    brokers: ["localhost:29092"]
  });
  const consumer = kafka.consumer({
    groupId: `catalog-e2e-${randomUUID()}`
  });
  await consumer.connect();
  await consumer.subscribe({
    topic: KAFKA_TOPICS.catalogBookEvents,
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
  bookId: string
): CollectedEvent | undefined {
  return events.find(
    (e) => e.eventType === eventType && e.payload?.bookId === bookId
  );
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
    GRPC_PORT: "50052",
    DATABASE_URL:
      "postgresql://catalog_user:catalog_pass@localhost:5432/catalog_db",
    REDIS_URL: "redis://localhost:6379",
    KAFKA_BROKERS: "localhost:29092",
    JWT_PUBLIC_KEY: Buffer.from(await exportSPKI(publicKey), "utf8").toString(
      "base64"
    ),
    RESERVATION_TTL_SEC: "900",
    RESERVATION_SWEEP_INTERVAL_SEC: "1"
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

async function createBook(
  catalog: CatalogClient,
  overrides: Partial<catalogProto.CreateBookRequest> = {}
): Promise<catalogProto.Book> {
  const res = await call(
    catalog.createBook(
      {
        bookName: uniqueName(),
        author: "E2E Author",
        isbn: uniqueIsbn(),
        price: 19.99,
        stock: 5,
        genre: "e2e",
        year: 2024,
        ...overrides
      },
      bearer(await signToken(UserRole.Admin))
    )
  );
  return res.book!;
}

describe("catalog-service e2e (real postgres + kafka + redis)", () => {
  let app: INestMicroservice;
  let catalog: CatalogClient;
  let consumer: Consumer;
  const events: CollectedEvent[] = [];

  beforeAll(async () => {
    await setBaseEnv();
    runMigrations();
    // Clean slate: earlier runs leave books/reservations behind, which would
    // push newly created rows past the first listBooks page these tests read.
    // RESTART IDENTITY CASCADE keeps the truncate working when a table that
    // is NOT listed here gains an FK onto any of these (outbox has none today).
    const prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "reservation_items", "reservations", "books", "outbox" RESTART IDENTITY CASCADE'
    );
    await prisma.$disconnect();
    app = await startApp(50052);
    catalog = grpcClient("127.0.0.1:50052");
    consumer = await startConsumer(events);
  }, 90_000);

  afterAll(async () => {
    await closeProxies();
    await consumer?.disconnect();
    await app?.close();
  }, 30_000);

  it("CreateBook → GetBook/ListBooks/SearchBooks → catalog.book.created delivered via outbox", async () => {
    const isbn = uniqueIsbn();
    const bookName = uniqueName();

    const created = await call(
      catalog.createBook(
        {
          bookName,
          author: "E2E Author",
          isbn,
          description: "e2e book",
          genre: "e2e-genre",
          year: 2024,
          price: 19.99,
          stock: 7
        },
        bearer(await signToken(UserRole.Admin))
      )
    );
    const book = created.book!;
    expect(book.bookId).toBeTruthy();
    expect(book.isbn).toBe(isbn);
    expect(book.price).toBe(19.99);
    expect(book.stock).toBe(7);
    expect(book.available).toBe(7);
    expect(book.isDeleted).toBe(false);

    // read paths are public — no metadata at all
    const fetched = await call(catalog.getBook({ bookId: book.bookId }));
    expect(fetched.book?.bookName).toBe(bookName);

    const listed = await call(catalog.listBooks({ offset: 0, limit: 100 }));
    expect(listed.total).toBeGreaterThanOrEqual(1);
    expect(listed.books.some((b) => b.bookId === book.bookId)).toBe(true);

    const found = await call(
      catalog.searchBooks({ query: bookName, offset: 0, limit: 10 })
    );
    expect(found.books.map((b) => b.bookId)).toContain(book.bookId);
    const byGenre = await call(
      catalog.searchBooks({ genre: "e2e-genre", offset: 0, limit: 100 })
    );
    expect(byGenre.books.map((b) => b.bookId)).toContain(book.bookId);

    // outbox → kafka delivery
    await waitFor(
      () => eventFor(events, EVENT_TYPES.bookCreated, book.bookId) !== undefined
    );
    const event = eventFor(events, EVENT_TYPES.bookCreated, book.bookId)!;
    expect(event.payload?.bookName).toBe(bookName);
    expect(event.payload?.author).toBe("E2E Author");
    expect(event.payload?.price).toBe(19.99);
  }, 60_000);

  it("rejects a duplicate isbn with ALREADY_EXISTS", async () => {
    const isbn = uniqueIsbn();
    await createBook(catalog, { isbn });
    await expectGrpcCode(
      call(
        catalog.createBook(
          {
            bookName: uniqueName(),
            author: "E2E Author",
            isbn,
            price: 5,
            stock: 1
          },
          bearer(await signToken(UserRole.Admin))
        )
      ),
      status.ALREADY_EXISTS
    );
  });

  it("UpdateBook patches fields and delivers catalog.book.updated", async () => {
    const book = await createBook(catalog, { price: 10, stock: 3 });

    const updated = await call(
      catalog.updateBook(
        { bookId: book.bookId, price: 42.5, stock: 9 },
        bearer(await signToken(UserRole.Employer))
      )
    );
    expect(updated.book?.price).toBe(42.5);
    expect(updated.book?.stock).toBe(9);
    expect(updated.book?.bookName).toBe(book.bookName); // untouched

    await waitFor(
      () => eventFor(events, EVENT_TYPES.bookUpdated, book.bookId) !== undefined
    );
    const event = eventFor(events, EVENT_TYPES.bookUpdated, book.bookId)!;
    expect(event.payload?.price).toBe(42.5);
  }, 60_000);

  it("DeleteBook is soft: still visible in reads, not reservable, book.deleted delivered; RestoreBook recovers", async () => {
    const book = await createBook(catalog, { stock: 4 });
    const admin = bearer(await signToken(UserRole.Admin));
    const customer = bearer(await signToken(UserRole.Customer));

    await call(catalog.deleteBook({ bookId: book.bookId }, admin));

    // still on the storefront
    const fetched = await call(catalog.getBook({ bookId: book.bookId }));
    expect(fetched.book?.isDeleted).toBe(true);
    expect(fetched.book?.available).toBe(0);
    const listed = await call(catalog.listBooks({ offset: 0, limit: 100 }));
    expect(listed.books.find((b) => b.bookId === book.bookId)?.isDeleted).toBe(
      true
    );

    // ...but cannot be reserved
    await expectGrpcCode(
      call(
        catalog.reserveStock(
          { items: [{ bookId: book.bookId, amount: 1 }] },
          customer
        )
      ),
      status.FAILED_PRECONDITION
    );

    await waitFor(
      () => eventFor(events, EVENT_TYPES.bookDeleted, book.bookId) !== undefined
    );

    // restore clears the flag and the book becomes reservable again
    const restored = await call(
      catalog.restoreBook({ bookId: book.bookId }, admin)
    );
    expect(restored.book?.isDeleted).toBe(false);
    expect(restored.book?.available).toBe(4);

    const reservation = await call(
      catalog.reserveStock(
        { items: [{ bookId: book.bookId, amount: 1 }] },
        customer
      )
    );
    expect(reservation.reservationId).toBeTruthy();
    await call(
      catalog.releaseStock(
        { reservationId: reservation.reservationId },
        customer
      )
    );
  }, 90_000);

  it("RestoreBook on a non-deleted book → FAILED_PRECONDITION", async () => {
    const book = await createBook(catalog);
    await expectGrpcCode(
      call(
        catalog.restoreBook(
          { bookId: book.bookId },
          bearer(await signToken(UserRole.Admin))
        )
      ),
      status.FAILED_PRECONDITION
    );
  });

  it("GetBooksByIds returns deleted books; NOT_FOUND only for missing ids", async () => {
    const book = await createBook(catalog);
    const deleted = await createBook(catalog);
    await call(
      catalog.deleteBook(
        { bookId: deleted.bookId },
        bearer(await signToken(UserRole.Admin))
      )
    );

    const res = await call(
      catalog.getBooksByIds({ bookIds: [book.bookId, deleted.bookId] })
    );
    expect(res.books).toHaveLength(2);
    const byId = new Map(res.books.map((b) => [b.bookId, b]));
    expect(byId.get(deleted.bookId)?.isDeleted).toBe(true);
    expect(byId.get(deleted.bookId)?.available).toBe(0);

    await expectGrpcCode(
      call(catalog.getBooksByIds({ bookIds: [book.bookId, randomUUID()] })),
      status.NOT_FOUND
    );
  }, 60_000);

  it("rejects limit > 100 with INVALID_ARGUMENT", async () => {
    await expectGrpcCode(
      call(catalog.listBooks({ offset: 0, limit: 101 })),
      status.INVALID_ARGUMENT
    );
    await expectGrpcCode(
      call(catalog.searchBooks({ offset: 0, limit: 500 })),
      status.INVALID_ARGUMENT
    );
  });

  it("rejects price above the Decimal(10,2) bound with INVALID_ARGUMENT", async () => {
    const admin = bearer(await signToken(UserRole.Admin));
    await expectGrpcCode(
      call(
        catalog.createBook(
          {
            bookName: uniqueName(),
            author: "E2E Author",
            price: 1e15,
            stock: 1
          },
          admin
        )
      ),
      status.INVALID_ARGUMENT
    );

    const book = await createBook(catalog, { price: 10 });
    await expectGrpcCode(
      call(catalog.updateBook({ bookId: book.bookId, price: 1e15 }, admin)),
      status.INVALID_ARGUMENT
    );
  });

  it("rejects malformed requests at the boundary", async () => {
    // Whether book_id arrives as "" or absent (proto3 implicit presence vs
    // protobufjs presence encoding), the boundary DTO must reject it — this
    // used to fall through to NOT_FOUND via the repository lookup.
    await expectGrpcCode(
      call(catalog.getBook({ bookId: "" })),
      status.INVALID_ARGUMENT
    );
    await expectGrpcCode(
      call(catalog.listBooks({ offset: -1, limit: 10 })),
      status.INVALID_ARGUMENT
    );
    const customer = bearer(await signToken(UserRole.Customer));
    await expectGrpcCode(
      call(
        catalog.reserveStock(
          { items: [{ bookId: "book-x", amount: 0 }] },
          customer
        )
      ),
      status.INVALID_ARGUMENT
    );
  });

  it("ReserveStock → CommitStock decrements stock; repeat commit is idempotent", async () => {
    const book = await createBook(catalog, { stock: 3 });
    const customer = bearer(await signToken(UserRole.Customer));

    const reservation = await call(
      catalog.reserveStock(
        { items: [{ bookId: book.bookId, amount: 2 }] },
        customer
      )
    );
    expect(reservation.reservationId).toBeTruthy();
    expect(Number(reservation.expiresAt?.seconds)).toBeGreaterThan(
      Math.floor(Date.now() / 1000)
    );

    await call(
      catalog.commitStock(
        { reservationId: reservation.reservationId },
        customer
      )
    );
    const committed = await call(catalog.getBook({ bookId: book.bookId }));
    expect(committed.book?.stock).toBe(1);
    expect(committed.book?.available).toBe(1);

    // idempotent retry — succeeds, stock unchanged
    await call(
      catalog.commitStock(
        { reservationId: reservation.reservationId },
        customer
      )
    );
    const after = await call(catalog.getBook({ bookId: book.bookId }));
    expect(after.book?.stock).toBe(1);
  }, 60_000);

  it("UpdateBook cannot lower stock below active reservations; CommitStock refuses to go negative", async () => {
    const book = await createBook(catalog, { stock: 4 });
    const admin = bearer(await signToken(UserRole.Admin));
    const customer = bearer(await signToken(UserRole.Customer));

    const reservation = await call(
      catalog.reserveStock(
        { items: [{ bookId: book.bookId, amount: 3 }] },
        customer
      )
    );

    // stock 2 < 3 reserved → FAILED_PRECONDITION; stock untouched
    await expectGrpcCode(
      call(catalog.updateBook({ bookId: book.bookId, stock: 2 }, admin)),
      status.FAILED_PRECONDITION
    );
    const unchanged = await call(catalog.getBook({ bookId: book.bookId }));
    expect(unchanged.book?.stock).toBe(4);

    // lowering to exactly the reserved amount is allowed
    const lowered = await call(
      catalog.updateBook({ bookId: book.bookId, stock: 3 }, admin)
    );
    expect(lowered.book?.stock).toBe(3);

    // stock can still drop below the reserved amount out-of-band (e.g.
    // manual correction, another writer) — the guarded commit must refuse
    // instead of driving books.stock negative
    const prisma = new PrismaClient();
    try {
      await prisma.$executeRawUnsafe(
        "UPDATE books SET stock = 0 WHERE id = $1",
        book.bookId
      );
    } finally {
      await prisma.$disconnect();
    }

    await expectGrpcCode(
      call(
        catalog.commitStock(
          { reservationId: reservation.reservationId },
          customer
        )
      ),
      status.FAILED_PRECONDITION
    );

    // rollback was total: stock untouched, reservation still ACTIVE
    const after = await call(catalog.getBook({ bookId: book.bookId }));
    expect(after.book?.stock).toBe(0);
    await call(
      catalog.releaseStock(
        { reservationId: reservation.reservationId },
        customer
      )
    );
  }, 60_000);

  it("SearchBooks treats an empty genre string as absent", async () => {
    const book = await createBook(catalog, { genre: "e2e-empty-genre" });
    const res = await call(
      catalog.searchBooks({ genre: "", offset: 0, limit: 100 })
    );
    expect(res.books.map((b) => b.bookId)).toContain(book.bookId);
  }, 60_000);

  it("ReserveStock → ReleaseStock restores availability", async () => {
    const book = await createBook(catalog, { stock: 2 });
    const customer = bearer(await signToken(UserRole.Customer));

    const reservation = await call(
      catalog.reserveStock(
        { items: [{ bookId: book.bookId, amount: 2 }] },
        customer
      )
    );
    const held = await call(catalog.getBook({ bookId: book.bookId }));
    expect(held.book?.available).toBe(0);

    await call(
      catalog.releaseStock(
        { reservationId: reservation.reservationId },
        customer
      )
    );
    const released = await call(catalog.getBook({ bookId: book.bookId }));
    expect(released.book?.available).toBe(2);
    expect(released.book?.stock).toBe(2);

    // a second release of the same reservation → FAILED_PRECONDITION
    await expectGrpcCode(
      call(
        catalog.releaseStock(
          { reservationId: reservation.reservationId },
          customer
        )
      ),
      status.FAILED_PRECONDITION
    );
  }, 60_000);

  it("enforces the JWT role matrix over real tokens", async () => {
    const admin = bearer(await signToken(UserRole.Admin));
    const employer = bearer(await signToken(UserRole.Employer));
    const customer = bearer(await signToken(UserRole.Customer));

    // reads are public — no token needed
    await call(catalog.listBooks({ offset: 0, limit: 10 }));

    // no token → UNAUTHENTICATED on protected RPCs
    await expectGrpcCode(
      call(
        catalog.createBook(
          {
            bookName: uniqueName(),
            author: "Anon",
            price: 1,
            stock: 1
          },
          new Metadata()
        )
      ),
      status.UNAUTHENTICATED
    );
    await expectGrpcCode(
      call(catalog.reserveStock({ items: [{ bookId: "x", amount: 1 }] })),
      status.UNAUTHENTICATED
    );

    // CUSTOMER cannot write books → PERMISSION_DENIED
    await expectGrpcCode(
      call(
        catalog.createBook(
          {
            bookName: uniqueName(),
            author: "Anon",
            price: 1,
            stock: 1
          },
          customer
        )
      ),
      status.PERMISSION_DENIED
    );

    // EMPLOYER can create/update but NOT delete/restore
    const book = await createBook(catalog);
    const patched = await call(
      catalog.updateBook({ bookId: book.bookId, price: 33 }, employer)
    );
    expect(patched.book?.price).toBe(33);
    await expectGrpcCode(
      call(catalog.deleteBook({ bookId: book.bookId }, employer)),
      status.PERMISSION_DENIED
    );
    await call(catalog.deleteBook({ bookId: book.bookId }, admin));
    await expectGrpcCode(
      call(catalog.restoreBook({ bookId: book.bookId }, employer)),
      status.PERMISSION_DENIED
    );
    await call(catalog.restoreBook({ bookId: book.bookId }, admin));

    // CUSTOMER can reserve/commit/release (order-service proxies user tokens)
    const res = await call(
      catalog.reserveStock(
        { items: [{ bookId: book.bookId, amount: 1 }] },
        customer
      )
    );
    await call(
      catalog.commitStock({ reservationId: res.reservationId }, customer)
    );

    // forged token (different key pair) → UNAUTHENTICATED
    const foreign = await generateKeyPair("EdDSA", { extractable: true });
    const forged = await new SignJWT({
      role: UserRole.Admin,
      user_name: "mallory",
      jti: randomUUID(),
      typ: "access"
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject(randomUUID())
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(foreign.privateKey);
    await expectGrpcCode(
      call(
        catalog.createBook(
          {
            bookName: uniqueName(),
            author: "Mallory",
            price: 1,
            stock: 1
          },
          bearer(forged)
        )
      ),
      status.UNAUTHENTICATED
    );
  }, 90_000);

  it("frees availability when a reservation TTL expires (RESERVATION_TTL_SEC=1)", async () => {
    // dedicated instance with a 1-second reservation TTL — the shared app
    // above keeps the default 900s so other tests are unaffected
    process.env.RESERVATION_TTL_SEC = "1";
    const ttlApp = await startApp(50072);
    const ttlClient = grpcClient("127.0.0.1:50072");
    try {
      const book = await createBook(ttlClient, { stock: 2 });
      const customer = bearer(await signToken(UserRole.Customer));

      const reservation = await call(
        ttlClient.reserveStock(
          { items: [{ bookId: book.bookId, amount: 2 }] },
          customer
        )
      );
      const held = await call(ttlClient.getBook({ bookId: book.bookId }));
      expect(held.book?.available).toBe(0);

      await sleep(1_500); // TTL elapsed — no manual release

      const freed = await call(ttlClient.getBook({ bookId: book.bookId }));
      expect(freed.book?.available).toBe(2);
      expect(freed.book?.stock).toBe(2);

      // an expired reservation can no longer be committed
      await expectGrpcCode(
        call(
          ttlClient.commitStock(
            { reservationId: reservation.reservationId },
            customer
          )
        ),
        status.NOT_FOUND
      );
    } finally {
      process.env.RESERVATION_TTL_SEC = "900";
      await closeProxies();
      await ttlApp.close();
    }
  }, 90_000);
});

describe("outbox relay survives broker outage", () => {
  it("CreateBook succeeds with a dead broker; a later instance publishes the event", async () => {
    // Service instance pointed at an unreachable broker must still boot and
    // serve RPCs — the outbox row persists, delivery happens later.
    process.env.KAFKA_BROKERS = "localhost:1";
    const deadBrokerApp = await startApp(50073);
    const deadClient = grpcClient("127.0.0.1:50073");

    const isbn = uniqueIsbn();
    const created = await call(
      deadClient.createBook(
        {
          bookName: uniqueName(),
          author: "Outage Author",
          isbn,
          price: 9.99,
          stock: 1
        },
        bearer(await signToken(UserRole.Admin))
      )
    );
    const bookId = created.book!.bookId;
    await closeProxies();
    await deadBrokerApp.close();

    // "Broker comes back": a fresh instance with working brokers picks the
    // unpublished outbox row up (shared catalog_db) and relays it.
    process.env.KAFKA_BROKERS = "localhost:29092";
    const recoveredApp = await startApp(50074);
    const events: CollectedEvent[] = [];
    const consumer = await startConsumer(events);
    try {
      await waitFor(
        () => eventFor(events, EVENT_TYPES.bookCreated, bookId) !== undefined,
        60_000
      );
      expect(
        eventFor(events, EVENT_TYPES.bookCreated, bookId)?.payload?.bookId
      ).toBe(bookId);
    } finally {
      await consumer.disconnect();
      await recoveredApp.close();
    }
  }, 120_000);
});
