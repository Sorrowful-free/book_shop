// Outbound gRPC dependencies (spec §5): cart.GetCart and the catalog
// snapshot/reserve/commit/release calls. The service talks to the
// CartClient/CatalogClient interfaces only — unit tests substitute fakes,
// production wires the grpc-js implementations below.
//
// Every call propagates the caller's `authorization` metadata verbatim
// (spec §2/§11) and carries a 5s deadline. Clients are created lazily —
// grpc-js channels connect on first use, so the service boots while the
// dependencies are still down and the deadline is what bounds the wait.

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
  ERROR_DETAILS_METADATA_KEY,
  GRPC_METADATA_KEYS
} from "@book-shop/common";
import { cartProto, catalogProto } from "@book-shop/contracts";

// Wire contract for structured error details lives in @book-shop/common
// (ERROR_DETAILS_METADATA_KEY) — re-exported so this module stays the
// single import surface for dependency-call plumbing.
export { ERROR_DETAILS_METADATA_KEY } from "@book-shop/common";

/** spec §11: gRPC deadline for cart/catalog calls. */
export const DEP_CALL_DEADLINE_MS = 5000;

// Short aliases keep the typed unary calls inside the print width.
type ReserveStockRequest = catalogProto.ReserveStockRequest;
type ReserveStockResponse = catalogProto.ReserveStockResponse;
type CommitStockRequest = catalogProto.CommitStockRequest;
type CommitStockResponse = catalogProto.CommitStockResponse;
type ReleaseStockRequest = catalogProto.ReleaseStockRequest;
type ReleaseStockResponse = catalogProto.ReleaseStockResponse;

// ---------------------------------------------------------------------------
// interfaces (what OrderService depends on — mocked in unit tests)
// ---------------------------------------------------------------------------

export interface CartClient {
  /** Caller's USER cart (no cartId — resolved server-side from the JWT). */
  getCart(metadata: Metadata): Promise<cartProto.Cart>;
}

export interface CatalogClient {
  getBooksByIds(
    bookIds: string[],
    metadata: Metadata
  ): Promise<catalogProto.Book[]>;
  reserveStock(
    items: catalogProto.StockReservationItem[],
    metadata: Metadata
  ): Promise<catalogProto.ReserveStockResponse>;
  commitStock(reservationId: string, metadata: Metadata): Promise<void>;
  releaseStock(reservationId: string, metadata: Metadata): Promise<void>;
}

export interface Closeable {
  close(): void;
}

// ---------------------------------------------------------------------------
// metadata propagation — `authorization` verbatim, nothing else
// ---------------------------------------------------------------------------

/**
 * Fresh outbound metadata carrying the caller's `authorization` value(s)
 * verbatim (spec §5). A copy — not the inbound object — so nothing else the
 * gateway sent (e.g. `x-user-*`, which downstream services must not trust)
 * leaks into dependency calls.
 */
export function forwardedAuthMetadata(source?: Metadata): Metadata {
  const metadata = new Metadata();
  for (const value of source?.get(GRPC_METADATA_KEYS.authorization) ?? []) {
    metadata.add(GRPC_METADATA_KEYS.authorization, value);
  }
  return metadata;
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
    // "dependency down" into a bounded UNAVAILABLE instead of a hung saga.
    const options: CallOptions = {
      deadline: Date.now() + DEP_CALL_DEADLINE_MS
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

export function createCartGrpcClient(addr: string): CartClient & Closeable {
  const client = createClient(
    cartProto.CartServiceService as unknown as ServiceDefinition<never>,
    cartProto.CART_SERVICE_NAME,
    addr
  );
  return {
    getCart: (metadata) =>
      unary<cartProto.GetCartRequest, cartProto.Cart>(
        client,
        "getCart",
        {},
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
    getBooksByIds: async (bookIds, metadata) => {
      const response = await unary<
        catalogProto.GetBooksByIdsRequest,
        catalogProto.GetBooksByIdsResponse
      >(client, "getBooksByIds", { bookIds }, metadata);
      return response.books;
    },
    reserveStock: (items, metadata) =>
      unary<ReserveStockRequest, ReserveStockResponse>(
        client,
        "reserveStock",
        { items },
        metadata
      ),
    commitStock: async (reservationId, metadata) => {
      await unary<CommitStockRequest, CommitStockResponse>(
        client,
        "commitStock",
        { reservationId },
        metadata
      );
    },
    releaseStock: async (reservationId, metadata) => {
      await unary<ReleaseStockRequest, ReleaseStockResponse>(
        client,
        "releaseStock",
        { reservationId },
        metadata
      );
    },
    close: () => client.close()
  };
}

// ---------------------------------------------------------------------------
// error readers — normalize the shapes a dependency error can take:
// in-process RpcException (unit fakes), grpc-js ServiceError (wire),
// RpcException payloads serialized as JSON into `details`.
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
  const payload = readExceptionPayload(error);
  if (payload && typeof payload.message === "string") {
    return payload.message;
  }
  return typeof err.message === "string" ? err.message : "unknown error";
}

/**
 * Structured `details` carried by a dependency error (F-O4), or undefined.
 * Recognized shapes, in order:
 * - RpcException payload `{code, message, details}` (`getError()`/`.error`)
 * - object `error.details` (duck-typed)
 * - `error.details` as a JSON string — either a raw details object or a
 *   serialized `{code, message, details}` envelope
 * - trailing metadata `error-details` JSON (the wire channel grpc-js
 *   actually forwards; see ERROR_DETAILS_METADATA_KEY)
 */
export function grpcErrorDetails(
  error: unknown
): Record<string, unknown> | undefined {
  const payload = readExceptionPayload(error);
  if (isPlainObject(payload?.details)) {
    return payload.details;
  }
  const err = error as { details?: unknown; error?: { details?: unknown } };
  if (isPlainObject(err.details)) {
    return err.details;
  }
  if (isPlainObject(err.error?.details)) {
    return err.error.details;
  }
  if (typeof err.details === "string") {
    const parsed = tryParseJson(err.details);
    if (isPlainObject(parsed)) {
      return isPlainObject(parsed.details) ? parsed.details : parsed;
    }
  }
  const metadata = (error as { metadata?: Metadata }).metadata;
  if (metadata instanceof Metadata) {
    for (const value of metadata.get(ERROR_DETAILS_METADATA_KEY)) {
      const parsed = tryParseJson(String(value));
      if (isPlainObject(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

/** Whether the dependency call failed in transport (not a domain answer). */
export function isTransportError(error: unknown): boolean {
  const code = grpcErrorCode(error);
  // connection refused / channel down → UNAVAILABLE; deadline →
  // DEADLINE_EXCEEDED; a non-grpc error reaching this point is also a call
  // failure, not a domain response (F-O4)
  return (
    code === undefined ||
    code === status.UNAVAILABLE ||
    code === status.DEADLINE_EXCEEDED
  );
}

type ExceptionPayload = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
};

function readExceptionPayload(error: unknown): ExceptionPayload | undefined {
  const err = error as {
    getError?: () => unknown;
    error?: unknown;
  };
  const payload = err?.getError?.() ?? err?.error;
  return isPlainObject(payload) ? payload : undefined;
}

function isPlainObject(
  value: unknown
): value is Record<string, unknown> & ExceptionPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
