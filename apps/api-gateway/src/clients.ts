// Outbound gRPC dependencies (spec §5): the gateway proxies to all four
// services. Controllers depend on the *Client interfaces only — unit tests
// substitute fakes, production wires the grpc-js implementations below.
//
// grpc-js channels connect lazily on first use, so the gateway boots while
// upstreams are still down; the per-call 5s deadline (spec §10) turns
// "dependency down" into a bounded UNAVAILABLE → 503 instead of a hung
// request.

import {
  credentials,
  makeGenericClientConstructor,
  Metadata,
  status,
  type CallOptions,
  type Client,
  type ClientUnaryCall,
  type ServiceDefinition,
  type ServiceError
} from "@grpc/grpc-js";
import {
  authProto,
  cartProto,
  catalogProto,
  orderProto
} from "@book-shop/contracts";

/** spec §10: gRPC deadline for upstream calls. */
export const UPSTREAM_DEADLINE_MS = 5000;

// ---------------------------------------------------------------------------
// interfaces (what controllers depend on — faked in tests)
// ---------------------------------------------------------------------------

export interface AuthClient {
  register(request: authProto.RegisterRequest): Promise<authProto.AuthTokens>;
  login(request: authProto.LoginRequest): Promise<authProto.AuthTokens>;
  refresh(request: authProto.RefreshRequest): Promise<authProto.AuthTokens>;
  revokeToken(request: authProto.RevokeTokenRequest): Promise<void>;
  getUser(
    request: authProto.GetUserRequest,
    metadata: Metadata
  ): Promise<authProto.User>;
}

export interface CatalogClient {
  listBooks(
    request: catalogProto.ListBooksRequest
  ): Promise<catalogProto.ListBooksResponse>;
  searchBooks(
    request: catalogProto.SearchBooksRequest
  ): Promise<catalogProto.SearchBooksResponse>;
  getBook(
    request: catalogProto.GetBookRequest
  ): Promise<catalogProto.GetBookResponse>;
  getBooksByIds(bookIds: string[]): Promise<catalogProto.Book[]>;
  createBook(
    request: catalogProto.CreateBookRequest,
    metadata: Metadata
  ): Promise<catalogProto.CreateBookResponse>;
  updateBook(
    request: catalogProto.UpdateBookRequest,
    metadata: Metadata
  ): Promise<catalogProto.UpdateBookResponse>;
  deleteBook(
    request: catalogProto.DeleteBookRequest,
    metadata: Metadata
  ): Promise<void>;
  restoreBook(
    request: catalogProto.RestoreBookRequest,
    metadata: Metadata
  ): Promise<catalogProto.RestoreBookResponse>;
}

export interface CartClient {
  createCart(metadata: Metadata): Promise<string>;
  getCart(
    request: cartProto.GetCartRequest,
    metadata: Metadata
  ): Promise<cartProto.Cart>;
  addItem(
    request: cartProto.AddItemRequest,
    metadata: Metadata
  ): Promise<cartProto.Cart>;
  updateItem(
    request: cartProto.UpdateItemRequest,
    metadata: Metadata
  ): Promise<cartProto.Cart>;
  removeItem(
    request: cartProto.RemoveItemRequest,
    metadata: Metadata
  ): Promise<cartProto.Cart>;
  clearCart(
    request: cartProto.ClearCartRequest,
    metadata: Metadata
  ): Promise<void>;
  mergeCart(
    request: cartProto.MergeCartRequest,
    metadata: Metadata
  ): Promise<cartProto.Cart>;
}

export interface OrderClient {
  checkout(
    request: orderProto.CheckoutRequest,
    metadata: Metadata
  ): Promise<orderProto.Order>;
  getOrder(
    request: orderProto.GetOrderRequest,
    metadata: Metadata
  ): Promise<orderProto.Order>;
  listMyOrders(
    request: orderProto.ListMyOrdersRequest,
    metadata: Metadata
  ): Promise<orderProto.ListMyOrdersResponse>;
  payOrder(
    request: orderProto.PayOrderRequest,
    metadata: Metadata
  ): Promise<orderProto.Order>;
  cancelOrder(
    request: orderProto.CancelOrderRequest,
    metadata: Metadata
  ): Promise<orderProto.Order>;
}

export interface Closeable {
  close(): void;
}

// ---------------------------------------------------------------------------
// grpc-js client factory
// ---------------------------------------------------------------------------

type UnaryInvoker<Req, Res> = (
  request: Req,
  metadata: Metadata,
  options: CallOptions,
  callback: (error: ServiceError | null, response: Res) => void
) => ClientUnaryCall;

function unary<Req, Res>(
  client: Client,
  method: string,
  request: Req,
  metadata: Metadata
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const invoker = (
      client as unknown as Record<string, UnaryInvoker<Req, Res>>
    )[method];
    // Every call gets its own deadline — the 5s budget is what turns
    // "dependency down" into a bounded UNAVAILABLE instead of a hang.
    const options: CallOptions = {
      deadline: Date.now() + UPSTREAM_DEADLINE_MS
    };
    invoker.call(client, request, metadata, options, (error, response) => {
      if (error) {
        reject(error);
      } else {
        resolve(response);
      }
    });
  });
}

function createClient(
  service: ServiceDefinition<never>,
  serviceName: string,
  addr: string
): Client {
  const Ctor = makeGenericClientConstructor(service, serviceName);
  // credentials.createInsecure — cluster-internal transport (spec §5)
  return new Ctor(addr, credentials.createInsecure());
}

const NO_METADATA = new Metadata();

export function createAuthGrpcClient(addr: string): AuthClient & Closeable {
  const client = createClient(
    authProto.AuthServiceService as unknown as ServiceDefinition<never>,
    authProto.AUTH_SERVICE_NAME,
    addr
  );
  return {
    register: (request) =>
      unary<authProto.RegisterRequest, authProto.AuthTokens>(
        client,
        "register",
        request,
        NO_METADATA
      ),
    login: (request) =>
      unary<authProto.LoginRequest, authProto.AuthTokens>(
        client,
        "login",
        request,
        NO_METADATA
      ),
    refresh: (request) =>
      unary<authProto.RefreshRequest, authProto.AuthTokens>(
        client,
        "refresh",
        request,
        NO_METADATA
      ),
    revokeToken: async (request) => {
      await unary<authProto.RevokeTokenRequest, Record<string, never>>(
        client,
        "revokeToken",
        request,
        NO_METADATA
      );
    },
    getUser: (request, metadata) =>
      unary<authProto.GetUserRequest, authProto.User>(
        client,
        "getUser",
        request,
        metadata
      ),
    close: () => client.close()
  };
}

export function createCatalogGrpcClient(
  addr: string
): CatalogClient & Closeable {
  const client = createClient(
    catalogProto.CatalogServiceService as unknown as ServiceDefinition<never>,
    catalogProto.CATALOG_SERVICE_NAME,
    addr
  );
  return {
    listBooks: (request) =>
      unary<catalogProto.ListBooksRequest, catalogProto.ListBooksResponse>(
        client,
        "listBooks",
        request,
        NO_METADATA
      ),
    searchBooks: (request) =>
      unary<catalogProto.SearchBooksRequest, catalogProto.SearchBooksResponse>(
        client,
        "searchBooks",
        request,
        NO_METADATA
      ),
    getBook: (request) =>
      unary<catalogProto.GetBookRequest, catalogProto.GetBookResponse>(
        client,
        "getBook",
        request,
        NO_METADATA
      ),
    getBooksByIds: async (bookIds) => {
      const response = await unary<
        catalogProto.GetBooksByIdsRequest,
        catalogProto.GetBooksByIdsResponse
      >(client, "getBooksByIds", { bookIds }, NO_METADATA);
      return response.books;
    },
    createBook: (request, metadata) =>
      unary<catalogProto.CreateBookRequest, catalogProto.CreateBookResponse>(
        client,
        "createBook",
        request,
        metadata
      ),
    updateBook: (request, metadata) =>
      unary<catalogProto.UpdateBookRequest, catalogProto.UpdateBookResponse>(
        client,
        "updateBook",
        request,
        metadata
      ),
    deleteBook: async (request, metadata) => {
      await unary<catalogProto.DeleteBookRequest, Record<string, never>>(
        client,
        "deleteBook",
        request,
        metadata
      );
    },
    restoreBook: (request, metadata) =>
      unary<catalogProto.RestoreBookRequest, catalogProto.RestoreBookResponse>(
        client,
        "restoreBook",
        request,
        metadata
      ),
    close: () => client.close()
  };
}

export function createCartGrpcClient(addr: string): CartClient & Closeable {
  const client = createClient(
    cartProto.CartServiceService as unknown as ServiceDefinition<never>,
    cartProto.CART_SERVICE_NAME,
    addr
  );
  return {
    createCart: async (metadata) => {
      const response = await unary<
        cartProto.CreateCartRequest,
        cartProto.CreateCartResponse
      >(client, "createCart", {}, metadata);
      return response.cartId;
    },
    getCart: (request, metadata) =>
      unary<cartProto.GetCartRequest, cartProto.Cart>(
        client,
        "getCart",
        request,
        metadata
      ),
    addItem: (request, metadata) =>
      unary<cartProto.AddItemRequest, cartProto.Cart>(
        client,
        "addItem",
        request,
        metadata
      ),
    updateItem: (request, metadata) =>
      unary<cartProto.UpdateItemRequest, cartProto.Cart>(
        client,
        "updateItem",
        request,
        metadata
      ),
    removeItem: (request, metadata) =>
      unary<cartProto.RemoveItemRequest, cartProto.Cart>(
        client,
        "removeItem",
        request,
        metadata
      ),
    clearCart: async (request, metadata) => {
      await unary<cartProto.ClearCartRequest, Record<string, never>>(
        client,
        "clearCart",
        request,
        metadata
      );
    },
    mergeCart: (request, metadata) =>
      unary<cartProto.MergeCartRequest, cartProto.Cart>(
        client,
        "mergeCart",
        request,
        metadata
      ),
    close: () => client.close()
  };
}

export function createOrderGrpcClient(addr: string): OrderClient & Closeable {
  const client = createClient(
    orderProto.OrderServiceService as unknown as ServiceDefinition<never>,
    orderProto.ORDER_SERVICE_NAME,
    addr
  );
  return {
    checkout: (request, metadata) =>
      unary<orderProto.CheckoutRequest, orderProto.Order>(
        client,
        "checkout",
        request,
        metadata
      ),
    getOrder: (request, metadata) =>
      unary<orderProto.GetOrderRequest, orderProto.Order>(
        client,
        "getOrder",
        request,
        metadata
      ),
    listMyOrders: (request, metadata) =>
      unary<orderProto.ListMyOrdersRequest, orderProto.ListMyOrdersResponse>(
        client,
        "listMyOrders",
        request,
        metadata
      ),
    payOrder: (request, metadata) =>
      unary<orderProto.PayOrderRequest, orderProto.Order>(
        client,
        "payOrder",
        request,
        metadata
      ),
    cancelOrder: (request, metadata) =>
      unary<orderProto.CancelOrderRequest, orderProto.Order>(
        client,
        "cancelOrder",
        request,
        metadata
      ),
    close: () => client.close()
  };
}

// ---------------------------------------------------------------------------
// error readers — normalize the shapes an upstream error can take:
// in-process RpcException (unit fakes) or grpc-js ServiceError (wire, where
// the message string lives in `details` by grpc-js convention).
// ---------------------------------------------------------------------------

export function grpcErrorCode(error: unknown): status | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "number" ? (code as status) : undefined;
}

/** Human-readable message: wire `details` string, else Error.message. */
export function grpcErrorMessage(error: unknown): string {
  const err = error as { details?: unknown; message?: unknown };
  if (typeof err.details === "string") {
    // A `{code, message, details}` envelope serialized into the details
    // string — surface the inner message, not the raw JSON blob.
    const parsed = tryParseJson(err.details);
    if (isPlainObject(parsed) && typeof parsed.message === "string") {
      return parsed.message;
    }
    return err.details;
  }
  return typeof err.message === "string" ? err.message : "unknown error";
}

/** Whether the upstream call failed in transport (not a domain answer). */
export function isTransportError(error: unknown): boolean {
  const code = grpcErrorCode(error);
  return (
    code === undefined ||
    code === status.UNAVAILABLE ||
    code === status.DEADLINE_EXCEEDED
  );
}

function isPlainObject(
  value: unknown
): value is Record<string, unknown> & { message?: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
