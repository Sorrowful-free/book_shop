// api-gateway e2e (spec §8/§9): supertest over the real HTTP app — global
// prefix, cookies, guards, filters — with all four upstreams replaced by
// in-process grpc-js stub servers built from the generated contract
// descriptors. Redis is real (denylist reads); everything else is stubbed.

import "reflect-metadata";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "bun:test";
import { randomUUID } from "node:crypto";
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
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Redis } from "ioredis";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import request from "supertest";
import {
  authProto,
  cartProto,
  catalogProto,
  orderProto,
  UserRole
} from "@book-shop/contracts";

const AUTH_ADDR = "127.0.0.1:50101";
const CATALOG_ADDR = "127.0.0.1:50102";
const CART_ADDR = "127.0.0.1:50103";
const ORDER_ADDR = "127.0.0.1:50104";
const REDIS_URL = "redis://localhost:6379";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A regex-valid key the catalog stub answers NOT_FOUND for. */
const MISSING_COVER_KEY = "00000000-0000-0000-0000-000000000000.png";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let signingKey: SigningKey;
let app: INestApplication;
let http: ReturnType<typeof request>;
const redis = new Redis(REDIS_URL, { lazyConnect: true });

// ---------------------------------------------------------------------------
// stub-server kit (same shape as order-service e2e): configurable errors,
// a full call log with the inbound metadata we care about.
// ---------------------------------------------------------------------------

interface StubError {
  code: status;
  message: string;
}

interface StubCall {
  method: string;
  request: Record<string, unknown>;
  authorization?: string;
  traceId?: string;
}

function stubError(error: StubError): ServiceError {
  return Object.assign(new Error(error.message), {
    code: error.code,
    details: error.message,
    metadata: new Metadata(),
    name: "ServiceError"
  }) as ServiceError;
}

function authorizationOf(metadata: Metadata): string | undefined {
  const value = metadata.get("authorization")[0];
  return value === undefined ? undefined : String(value);
}

function traceIdOf(metadata: Metadata): string | undefined {
  const value = metadata.get("x-trace-id")[0];
  return value === undefined ? undefined : String(value);
}

function unimplementedStub<Req, Res>(
  _call: ServerUnaryCall<Req, Res>,
  callback: sendUnaryData<Res>
): void {
  callback(
    stubError({ code: status.UNIMPLEMENTED, message: "not implemented" }),
    null as never
  );
}

/** Handler-time error — thrown inside `respond` to surface a wire error. */
class StubResponse extends Error {
  constructor(
    readonly code: status,
    message: string
  ) {
    super(message);
  }
}

abstract class Stub {
  calls: StubCall[] = [];
  errors = new Map<string, StubError>();

  reset(): void {
    this.calls = [];
    this.errors = new Map();
  }

  callsOf(method: string): StubCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /**
   * grpc-js unary handler: records the call (+ auth/trace metadata), honors
   * a configured error, otherwise delegates to `respond` — which may throw
   * a StubResponse to answer with a wire error.
   */
  handle<Req extends object, Res>(
    method: string,
    respond: (request: Req) => Res
  ) {
    return (call: ServerUnaryCall<Req, Res>, callback: sendUnaryData<Res>) => {
      this.calls.push({
        method,
        request: call.request as Record<string, unknown>,
        authorization: authorizationOf(call.metadata),
        traceId: traceIdOf(call.metadata)
      });
      const error = this.errors.get(method);
      if (error) {
        callback(stubError(error), null as never);
        return;
      }
      try {
        callback(null, respond(call.request));
      } catch (thrown) {
        if (thrown instanceof StubResponse) {
          callback(
            stubError({ code: thrown.code, message: thrown.message }),
            null as never
          );
          return;
        }
        throw thrown;
      }
    };
  }
}

// ---------------------------------------------------------------------------
// the four upstream stubs
// ---------------------------------------------------------------------------

class AuthStub extends Stub {
  tokens: authProto.AuthTokens = {
    accessToken: "access.jwt",
    refreshToken: "refresh.jwt",
    accessTokenExpiresIn: 900,
    refreshTokenExpiresIn: 2_592_000
  };
  user: authProto.User = {
    userId: "",
    userName: "e2e",
    role: authProto.Role.ROLE_CUSTOMER
  };

  override reset(): void {
    super.reset();
    this.tokens = {
      accessToken: "access.jwt",
      refreshToken: "refresh.jwt",
      accessTokenExpiresIn: 900,
      refreshTokenExpiresIn: 2_592_000
    };
  }

  handlers(): authProto.AuthServiceServer {
    return {
      register: this.handle("register", () => this.tokens),
      login: this.handle("login", () => this.tokens),
      refresh: this.handle("refresh", () => this.tokens),
      revokeToken: this.handle("revokeToken", () => ({})),
      validateToken: unimplementedStub,
      getUser: this.handle("getUser", (r: authProto.GetUserRequest) => ({
        ...this.user,
        userId: r.userId
      }))
    };
  }
}

class CatalogStub extends Stub {
  books = new Map<string, catalogProto.Book>();

  override reset(): void {
    super.reset();
    this.books = new Map();
  }

  handlers(): catalogProto.CatalogServiceServer {
    return {
      listBooks: this.handle(
        "listBooks",
        (r: catalogProto.ListBooksRequest) => {
          const books = [...this.books.values()];
          return {
            books: books.slice(r.offset, r.offset + r.limit),
            total: books.length
          };
        }
      ),
      searchBooks: this.handle(
        "searchBooks",
        (r: catalogProto.SearchBooksRequest) => {
          const books = [...this.books.values()].filter(
            (book) =>
              (!r.query || book.bookName.includes(r.query)) &&
              (!r.genre || book.genre === r.genre)
          );
          return {
            books: books.slice(r.offset, r.offset + r.limit),
            total: books.length
          };
        }
      ),
      getBook: this.handle("getBook", (r: catalogProto.GetBookRequest) => {
        const book = this.books.get(r.bookId);
        if (!book) {
          throw new StubResponse(
            status.NOT_FOUND,
            `book ${r.bookId} not found`
          );
        }
        return { book };
      }),
      // Same all-or-nothing contract as the real service: NOT_FOUND when
      // ANY id is missing — this is what the gateway degrades on.
      getBooksByIds: this.handle(
        "getBooksByIds",
        (r: catalogProto.GetBooksByIdsRequest) => {
          const missing = r.bookIds.filter((id) => !this.books.has(id));
          if (missing.length > 0) {
            throw new StubResponse(
              status.NOT_FOUND,
              `books not found: ${missing.join(", ")}`
            );
          }
          return { books: r.bookIds.map((id) => this.books.get(id)!) };
        }
      ),
      createBook: this.handle(
        "createBook",
        (r: catalogProto.CreateBookRequest) => ({
          book: {
            ...r,
            bookId: `book-${randomUUID().slice(0, 8)}`,
            available: r.stock,
            isDeleted: false
          }
        })
      ),
      updateBook: this.handle(
        "updateBook",
        (r: catalogProto.UpdateBookRequest) => ({
          book: {
            bookId: r.bookId,
            bookName: r.bookName ?? "n",
            author: r.author ?? "a",
            price: r.price ?? 0,
            stock: r.stock ?? 0,
            available: r.stock ?? 0,
            isDeleted: false
          }
        })
      ),
      deleteBook: this.handle("deleteBook", () => ({})),
      restoreBook: this.handle(
        "restoreBook",
        (r: catalogProto.RestoreBookRequest) => ({
          book: {
            bookId: r.bookId,
            bookName: "n",
            author: "a",
            price: 0,
            stock: 0,
            available: 0,
            isDeleted: false
          }
        })
      ),
      reserveStock: unimplementedStub,
      commitStock: unimplementedStub,
      releaseStock: unimplementedStub,
      createCoverUpload: this.handle(
        "createCoverUpload",
        (r: catalogProto.CreateCoverUploadRequest) => ({
          uploadUrl: "http://localhost:9000/book-covers",
          fields: { key: "k", policy: "p", "Content-Type": r.contentType },
          coverUrl: `/api/v1/covers/${randomUUID()}.png`
        })
      ),
      getBookCover: this.handle(
        "getBookCover",
        (r: catalogProto.GetBookCoverRequest) => {
          if (r.key === MISSING_COVER_KEY) {
            throw new StubResponse(status.NOT_FOUND, "cover not found");
          }
          return {
            data: Buffer.from("cover-bytes"),
            contentType: "image/png"
          };
        }
      )
    };
  }
}

class CartStub extends Stub {
  cart: cartProto.Cart = { items: [] };
  nextCartId = randomUUID();

  override reset(): void {
    super.reset();
    this.cart = { items: [] };
    this.nextCartId = randomUUID();
  }

  handlers(): cartProto.CartServiceServer {
    return {
      createCart: this.handle("createCart", () => ({
        cartId: this.nextCartId
      })),
      getCart: this.handle("getCart", () => this.cart),
      addItem: this.handle("addItem", () => this.cart),
      updateItem: this.handle("updateItem", () => this.cart),
      removeItem: this.handle("removeItem", () => this.cart),
      clearCart: this.handle("clearCart", () => ({})),
      mergeCart: this.handle("mergeCart", () => this.cart)
    };
  }
}

class OrderStub extends Stub {
  order: orderProto.Order = {
    orderId: randomUUID(),
    userId: "u-1",
    items: [
      {
        bookId: "b-1",
        bookName: "Dune",
        author: "Herbert",
        price: 10,
        amount: 1
      }
    ],
    totalPrice: 10,
    status: orderProto.OrderStatus.ORDER_STATUS_PENDING,
    createdAt: { seconds: 1_700_000_000, nanos: 0 }
  };

  handlers(): orderProto.OrderServiceServer {
    return {
      checkout: this.handle("checkout", () => this.order),
      getOrder: this.handle("getOrder", () => this.order),
      listMyOrders: this.handle("listMyOrders", () => ({
        orders: [this.order],
        total: 1
      })),
      payOrder: this.handle("payOrder", () => this.order),
      cancelOrder: this.handle("cancelOrder", () => this.order)
    };
  }
}

const authStub = new AuthStub();
const catalogStub = new CatalogStub();
const cartStub = new CartStub();
const orderStub = new OrderStub();

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

const servers: Server[] = [];

// ---------------------------------------------------------------------------
// app lifecycle + helpers
// ---------------------------------------------------------------------------

async function signToken(
  role: UserRole = UserRole.Customer,
  jti = randomUUID(),
  expiresIn = "15m"
): Promise<string> {
  return new SignJWT({ role, user_name: "e2e", typ: "access" })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject(`u-${randomUUID().slice(0, 8)}`)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(signingKey);
}

function setCookiesOf(res: request.Response): string[] {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function cookieValue(setCookies: string[], name: string): string | undefined {
  return setCookies.find((c) => c.startsWith(`${name}=`));
}

function seedBook(
  overrides: Partial<catalogProto.Book> & { bookId: string }
): catalogProto.Book {
  const book: catalogProto.Book = {
    bookName: `Book ${overrides.bookId}`,
    author: "E2E Author",
    price: 10,
    stock: 5,
    available: 5,
    isDeleted: false,
    ...overrides
  };
  catalogStub.books.set(book.bookId, book);
  return book;
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    extractable: true
  });
  signingKey = privateKey;
  Object.assign(process.env, {
    JWT_PUBLIC_KEY: Buffer.from(await exportSPKI(publicKey), "utf8").toString(
      "base64"
    ),
    REDIS_URL,
    AUTH_GRPC_ADDR: AUTH_ADDR,
    CATALOG_GRPC_ADDR: CATALOG_ADDR,
    CART_GRPC_ADDR: CART_ADDR,
    ORDER_GRPC_ADDR: ORDER_ADDR,
    COOKIE_SECURE: "false",
    CORS_ORIGIN: "http://localhost:3001"
  });

  servers.push(
    await startStubServer(
      authProto.AuthServiceService,
      authStub.handlers(),
      AUTH_ADDR
    ),
    await startStubServer(
      catalogProto.CatalogServiceService,
      catalogStub.handlers(),
      CATALOG_ADDR
    ),
    await startStubServer(
      cartProto.CartServiceService,
      cartStub.handlers(),
      CART_ADDR
    ),
    await startStubServer(
      orderProto.OrderServiceService,
      orderStub.handlers(),
      ORDER_ADDR
    )
  );

  const { AppModule } = await import("../src/app.module");
  const { configureApp } = await import("../src/setup");
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.init();
  http = request(app.getHttpServer());
  await redis.connect();
});

afterAll(async () => {
  await app?.close();
  for (const server of servers) {
    server.tryShutdown(() => {});
    server.forceShutdown();
  }
  redis.disconnect();
});

beforeEach(() => {
  authStub.reset();
  catalogStub.reset();
  cartStub.reset();
  orderStub.reset();
});

// ---------------------------------------------------------------------------
// spec §8 acceptance scenarios
// ---------------------------------------------------------------------------

describe("auth cookie session (spec §2/§8)", () => {
  it("register sets httpOnly cookies and returns tokens in the body", async () => {
    const res = await http
      .post("/api/v1/auth/register")
      .send({ userName: "alice_1", password: "secret-1!" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      accessToken: "access.jwt",
      refreshToken: "refresh.jwt"
    });
    const cookies = setCookiesOf(res);
    expect(cookieValue(cookies, "access_token")).toContain("HttpOnly");
    expect(cookieValue(cookies, "refresh_token")).toContain("HttpOnly");
    expect(cookieValue(cookies, "access_token")).toContain("SameSite=Lax");
    expect(authStub.callsOf("register")).toHaveLength(1);
  });

  it("a cookie session authorizes /auth/me; Bearer works too", async () => {
    const token = await signToken();
    const viaCookie = await http
      .get("/api/v1/auth/me")
      .set("Cookie", `access_token=${token}`);
    expect(viaCookie.status).toBe(200);
    expect(viaCookie.body).toMatchObject({ role: "CUSTOMER" });

    const viaBearer = await http
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(viaBearer.status).toBe(200);
    // the raw JWT is forwarded as `authorization` metadata — never x-user-*
    const call = authStub.callsOf("getUser")[0];
    expect(call.authorization).toBe(`Bearer ${token}`);
  });

  it("login merges the guest cart and clears its cookie", async () => {
    const guest = await http.get("/api/v1/cart");
    const cartCookie = cookieValue(setCookiesOf(guest), "cart_id");
    expect(cartCookie).toBeDefined();

    const res = await http
      .post("/api/v1/auth/login")
      .set("Cookie", cartCookie!)
      .send({ userName: "alice_1", password: "secret-1!" });
    expect(res.status).toBe(200);
    const merge = cartStub.callsOf("mergeCart");
    expect(merge).toHaveLength(1);
    expect(merge[0].request.guestCartId).toBe(cartStub.nextCartId);
    expect(merge[0].authorization).toBe("Bearer access.jwt");
    // cart_id cleared (expires-in-the-past clear)
    expect(cookieValue(setCookiesOf(res), "cart_id")).toMatch(/Expires=/i);
  });

  it("refresh rotates the pair from the refresh cookie; revoked → 401", async () => {
    const res = await http
      .post("/api/v1/auth/refresh")
      .set("Cookie", "refresh_token=old-rt");
    expect(res.status).toBe(200);
    expect(authStub.callsOf("refresh")[0].request).toEqual({
      refreshToken: "old-rt"
    });
    expect(cookieValue(setCookiesOf(res), "access_token")).toContain(
      "access.jwt"
    );

    authStub.errors.set("refresh", {
      code: status.UNAUTHENTICATED,
      message: "refresh token revoked"
    });
    const failed = await http
      .post("/api/v1/auth/refresh")
      .set("Cookie", "refresh_token=revoked");
    expect(failed.status).toBe(401);
    expect(failed.body).toMatchObject({
      statusCode: 401,
      message: "refresh token revoked"
    });
  });

  it("refresh without any credential → 400", async () => {
    const res = await http.post("/api/v1/auth/refresh").send({});
    expect(res.status).toBe(400);
    expect(authStub.callsOf("refresh")).toHaveLength(0);
  });

  it("logout revokes and always clears the cookies → 204", async () => {
    const access = await signToken();
    const res = await http
      .post("/api/v1/auth/logout")
      .set("Cookie", `refresh_token=rt-1; access_token=${access}`);
    expect(res.status).toBe(204);
    const revoke = authStub.callsOf("revokeToken");
    expect(revoke).toHaveLength(1);
    expect(revoke[0].request).toEqual({
      refreshToken: "rt-1",
      accessToken: access
    });
    const cookies = setCookiesOf(res);
    expect(cookieValue(cookies, "access_token")).toMatch(/Expires=/i);
    expect(cookieValue(cookies, "refresh_token")).toMatch(/Expires=/i);

    // a revoke failure still logs out
    authStub.errors.set("revokeToken", {
      code: status.UNAUTHENTICATED,
      message: "expired refresh"
    });
    const failed = await http
      .post("/api/v1/auth/logout")
      .set("Cookie", "refresh_token=rt-2");
    expect(failed.status).toBe(204);
    expect(cookieValue(setCookiesOf(failed), "refresh_token")).toMatch(
      /Expires=/i
    );
  });
});

describe("role matrix and guard (spec §2/§3)", () => {
  it("protected routes reject anonymous callers → 401", async () => {
    expect((await http.get("/api/v1/orders")).status).toBe(401);
    expect((await http.post("/api/v1/orders/checkout")).status).toBe(401);
    expect((await http.post("/api/v1/books").send({})).status).toBe(401);
  });

  it("CUSTOMER cannot create books → 403; EMPLOYER can → 201", async () => {
    const customer = await signToken(UserRole.Customer);
    const denied = await http
      .post("/api/v1/books")
      .set("Authorization", `Bearer ${customer}`)
      .send({ bookName: "x", author: "y", price: 1, stock: 1 });
    expect(denied.status).toBe(403);
    expect(catalogStub.callsOf("createBook")).toHaveLength(0);

    const employer = await signToken(UserRole.Employer);
    const allowed = await http
      .post("/api/v1/books")
      .set("Authorization", `Bearer ${employer}`)
      .send({ bookName: "x", author: "y", price: 1, stock: 1 });
    expect(allowed.status).toBe(201);
    const call = catalogStub.callsOf("createBook")[0];
    expect(call.authorization).toBe(`Bearer ${employer}`);
  });

  it("only ADMIN deletes/restores — EMPLOYER → 403", async () => {
    const employer = await signToken(UserRole.Employer);
    const denied = await http
      .delete("/api/v1/books/b-1")
      .set("Authorization", `Bearer ${employer}`);
    expect(denied.status).toBe(403);

    const admin = await signToken(UserRole.Admin);
    const deleted = await http
      .delete("/api/v1/books/b-1")
      .set("Authorization", `Bearer ${admin}`);
    expect(deleted.status).toBe(204);
    const restored = await http
      .post("/api/v1/books/b-1/restore")
      .set("Authorization", `Bearer ${admin}`);
    expect(restored.status).toBe(200);
  });

  it("a revoked jti (Redis denylist) rejects a valid-looking token → 401", async () => {
    const jti = randomUUID();
    const token = await signToken(UserRole.Customer, jti);
    await redis.set(`auth:revoked:${jti}`, "1");
    try {
      const res = await http
        .get("/api/v1/orders")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
    } finally {
      await redis.del(`auth:revoked:${jti}`);
    }
  });
});

describe("books proxy (spec §2)", () => {
  it("public reads — list/search/get", async () => {
    seedBook({ bookId: "b-1", bookName: "Dune", genre: "sci-fi" });
    seedBook({ bookId: "b-2", bookName: "Emma", genre: "classic" });

    const list = await http.get("/api/v1/books?limit=10");
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    expect(catalogStub.callsOf("listBooks")).toHaveLength(1);

    const search = await http.get("/api/v1/books?genre=sci-fi");
    expect(search.status).toBe(200);
    expect(search.body.books).toHaveLength(1);
    const searchCall = catalogStub.callsOf("searchBooks")[0];
    expect(searchCall.request.genre).toBe("sci-fi");

    const one = await http.get("/api/v1/books/b-1");
    expect(one.status).toBe(200);
    expect(one.body.bookName).toBe("Dune");
  });
});

describe("covers proxy (spec 08 §5)", () => {
  it("POST /covers/upload is staff-only: anon → 401, CUSTOMER → 403, EMPLOYER/ADMIN → 200", async () => {
    const anon = await http
      .post("/api/v1/covers/upload")
      .send({ contentType: "image/png" });
    expect(anon.status).toBe(401);

    const customer = await signToken(UserRole.Customer);
    const denied = await http
      .post("/api/v1/covers/upload")
      .set("Authorization", `Bearer ${customer}`)
      .send({ contentType: "image/png" });
    expect(denied.status).toBe(403);
    expect(catalogStub.callsOf("createCoverUpload")).toHaveLength(0);

    for (const role of [UserRole.Employer, UserRole.Admin]) {
      const token = await signToken(role);
      const res = await http
        .post("/api/v1/covers/upload")
        .set("Authorization", `Bearer ${token}`)
        .send({ contentType: "image/png" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        uploadUrl: "http://localhost:9000/book-covers",
        coverUrl: expect.stringMatching(/^\/api\/v1\/covers\//)
      });
      expect(res.body.fields).toBeDefined();
      // the caller's JWT is forwarded for the service-side re-check
      const call = catalogStub.callsOf("createCoverUpload").at(-1)!;
      expect(call.authorization).toBe(`Bearer ${token}`);
    }
  });

  it("POST /covers/upload rejects a mime outside the whitelist → 400", async () => {
    const admin = await signToken(UserRole.Admin);
    const res = await http
      .post("/api/v1/covers/upload")
      .set("Authorization", `Bearer ${admin}`)
      .send({ contentType: "image/gif" });
    expect(res.status).toBe(400);
    expect(catalogStub.callsOf("createCoverUpload")).toHaveLength(0);
  });

  it("GET /covers/:key is public and streams bytes with immutable caching", async () => {
    const key = `${randomUUID()}.png`;
    const res = await http.get(`/api/v1/covers/${key}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(res.headers["content-length"]).toBe("11");
    expect(res.body.toString()).toBe("cover-bytes");
  });

  it("GET /covers/:key maps NOT_FOUND → 404 and INVALID_ARGUMENT → 400", async () => {
    const missing = await http.get(`/api/v1/covers/${MISSING_COVER_KEY}`);
    expect(missing.status).toBe(404);

    // malformed keys never reach upstream
    for (const bad of ["..", "garbage", `${randomUUID()}.gif`]) {
      const res = await http.get(`/api/v1/covers/${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
    }
    expect(catalogStub.callsOf("getBookCover")).toHaveLength(1);
  });
});

describe("cart — guest/user owner resolution (spec §2/§8)", () => {
  it("first guest touch creates the cart and sets cart_id", async () => {
    const res = await http.get("/api/v1/cart");
    expect(res.status).toBe(200);
    expect(cookieValue(setCookiesOf(res), "cart_id")).toContain(
      cartStub.nextCartId
    );
    expect(cartStub.callsOf("createCart")).toHaveLength(1);
    const get = cartStub.callsOf("getCart")[0];
    expect(get.request.cartId).toBe(cartStub.nextCartId);
  });

  it("an existing cart_id cookie is passed through; no CreateCart", async () => {
    const res = await http
      .post("/api/v1/cart/items")
      .set("Cookie", "cart_id=guest-7")
      .send({ bookId: "b-1", amount: 2 });
    expect(res.status).toBe(200);
    expect(cartStub.callsOf("createCart")).toHaveLength(0);
    const add = cartStub.callsOf("addItem")[0];
    expect(add.request).toMatchObject({
      cartId: "guest-7",
      bookId: "b-1",
      amount: 2
    });
  });

  it("authenticated requests IGNORE the cart_id cookie (user cart)", async () => {
    const token = await signToken();
    const res = await http
      .get("/api/v1/cart")
      .set("Authorization", `Bearer ${token}`)
      .set("Cookie", "cart_id=guest-7");
    expect(res.status).toBe(200);
    expect(cartStub.callsOf("createCart")).toHaveLength(0);
    const get = cartStub.callsOf("getCart")[0];
    expect(get.request.cartId).toBeUndefined();
    expect(get.authorization).toBe(`Bearer ${token}`);
  });

  it("GET /cart enriches positions from the catalog", async () => {
    seedBook({
      bookId: "b-1",
      bookName: "Dune",
      author: "Herbert",
      price: 9.5,
      available: 4
    });
    cartStub.cart = { items: [{ bookId: "b-1", amount: 2 }] };
    const res = await http.get("/api/v1/cart").set("Cookie", "cart_id=g-1");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      {
        bookId: "b-1",
        amount: 2,
        bookName: "Dune",
        author: "Herbert",
        price: 9.5,
        available: 4
      }
    ]);
  });

  it("a deleted book degrades to available:false — the request survives", async () => {
    seedBook({ bookId: "b-1", bookName: "Dune", available: 4 });
    cartStub.cart = {
      items: [
        { bookId: "b-1", amount: 1 },
        { bookId: "gone", amount: 3 }
      ]
    };
    const res = await http.get("/api/v1/cart").set("Cookie", "cart_id=g-1");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      {
        bookId: "b-1",
        amount: 1,
        bookName: "Dune",
        author: "E2E Author",
        price: 10,
        available: 4
      },
      { bookId: "gone", amount: 3, available: false }
    ]);
  });
});

describe("orders proxy (spec §2/§8)", () => {
  it("checkout requires auth → 401 anonymous", async () => {
    const res = await http.post("/api/v1/orders/checkout");
    expect(res.status).toBe(401);
    expect(orderStub.callsOf("checkout")).toHaveLength(0);
  });

  it("checkout proxies with the Idempotency-Key header", async () => {
    const token = await signToken();
    const res = await http
      .post("/api/v1/orders/checkout")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "key-123");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PENDING");
    const call = orderStub.callsOf("checkout")[0];
    expect(call.request.idempotencyKey).toBe("key-123");
    expect(call.authorization).toBe(`Bearer ${token}`);
  });

  it("checkout generates a uuid key when the header is absent", async () => {
    const token = await signToken();
    const res = await http
      .post("/api/v1/orders/checkout")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const call = orderStub.callsOf("checkout")[0];
    expect(String(call.request.idempotencyKey)).toMatch(UUID_RE);
  });

  it("lists own orders", async () => {
    const token = await signToken();
    const res = await http
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1 });
    expect(res.body.orders[0].status).toBe("PENDING");
    expect(res.body.orders[0].createdAt).toBe(
      new Date(1_700_000_000_000).toISOString()
    );
  });
});

describe("error mapping and edges (spec §6/§8)", () => {
  it("NOT_FOUND → 404 with the unified body", async () => {
    const res = await http.get("/api/v1/books/missing");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ statusCode: 404, error: "Not Found" });
    expect(String(res.body.message)).toContain("missing");
  });

  it("UNAVAILABLE → 503", async () => {
    catalogStub.errors.set("listBooks", {
      code: status.UNAVAILABLE,
      message: "catalog down"
    });
    const res = await http.get("/api/v1/books");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ statusCode: 503 });
  });

  it("ALREADY_EXISTS → 409", async () => {
    authStub.errors.set("register", {
      code: status.ALREADY_EXISTS,
      message: "user alice_1 already exists"
    });
    const res = await http
      .post("/api/v1/auth/register")
      .send({ userName: "alice_1", password: "x" });
    expect(res.status).toBe(409);
  });

  it("body validation rejects before any upstream call → 400", async () => {
    const res = await http
      .post("/api/v1/cart/items")
      .send({ bookId: "", amount: 0 });
    expect(res.status).toBe(400);
    expect(cartStub.calls).toHaveLength(0);
  });

  it("x-trace-id propagates to upstream metadata", async () => {
    const token = await signToken();
    await http
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-trace-id", "trace-9");
    expect(orderStub.callsOf("listMyOrders")[0].traceId).toBe("trace-9");
  });

  it("swagger UI and the openapi document are served outside the prefix", async () => {
    const ui = await http.get("/api/docs/");
    expect(ui.status).toBe(200);
    const doc = await http.get("/api/docs-json");
    expect(doc.status).toBe(200);
    expect(doc.body.openapi).toBeDefined();
    expect(Object.keys(doc.body.paths)).toContain("/api/v1/auth/register");
  });
});
