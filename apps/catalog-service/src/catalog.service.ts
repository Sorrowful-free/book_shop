// Core catalog logic (spec docs/specs/02-catalog-service.md).
//
// DB access goes through the CatalogRepository contract (Prisma adapter in
// production, in-memory test double in unit tests). Errors are RpcException
// objects carrying { code, message }: unit tests read `getError().code` and
// the NestJS gRPC layer serializes the same object into the wire status.
//
// `caller` is the already-verified JWT user context — `null` when no valid
// token was supplied. `authorization` metadata → UserContext happens in the
// gRPC controller (JwtVerifier + RedisTokenDenylist from @book-shop/common).

import { Injectable } from "@nestjs/common";
import { status } from "@grpc/grpc-js";
import { RpcException } from "@nestjs/microservices";
import type { UserContext } from "@book-shop/common";
import {
  EVENT_TYPES,
  UserRole,
  type BookCreatedPayload,
  type BookDeletedPayload,
  type BookUpdatedPayload
} from "@book-shop/contracts";
import type {
  Book,
  CommitStockRequest,
  CommitStockResponse,
  CreateBookRequest,
  CreateBookResponse,
  DeleteBookRequest,
  DeleteBookResponse,
  GetBookRequest,
  GetBookResponse,
  GetBooksByIdsRequest,
  GetBooksByIdsResponse,
  ListBooksRequest,
  ListBooksResponse,
  ReleaseStockRequest,
  ReleaseStockResponse,
  ReserveStockRequest,
  ReserveStockResponse,
  RestoreBookRequest,
  RestoreBookResponse,
  SearchBooksRequest,
  SearchBooksResponse,
  UpdateBookRequest,
  UpdateBookResponse
} from "@book-shop/contracts/gen/catalog";
import type { Timestamp } from "@book-shop/contracts/gen/google/protobuf/timestamp";
import type {
  BookPatch,
  BookRecord,
  CatalogRepository,
  NewBook
} from "./repository";
import { StockBelowReservedError } from "./repository";

export interface CatalogServiceDeps {
  repository: CatalogRepository;
  /** Reservation TTL in seconds (env RESERVATION_TTL_SEC, default 900). */
  reservationTtlSec?: number;
  /** Injectable clock — lets unit tests expire reservations deterministically. */
  now?: () => Date;
}

/** limit upper bound — shared with the request DTOs (fixes F-C3). */
export const MAX_LIMIT = 100;

/**
 * books.price is Decimal(10,2) — a `double` above ~1e8 (e.g. `price: 1e15`)
 * fits the wire type but overflows the column, and Prisma would answer
 * UNKNOWN; bound it to INVALID_ARGUMENT here instead (fixes F-C2).
 */
const MAX_PRICE = 99_999_999.99;

/** int4 bound — books.stock and the aggregated reservation amount (F-C2). */
const MAX_INT32 = 2_147_483_647;

function rpcError(code: status, message: string): RpcException {
  // Expose the grpc status on the exception itself too — some tests (and
  // grpc-js error mapping) read `error.code` directly, others read the
  // RpcException payload via `getError().code`.
  return Object.assign(new RpcException({ code, message }), { code });
}

function toTimestamp(date: Date): Timestamp {
  const ms = date.getTime();
  return {
    seconds: Math.floor(ms / 1000),
    nanos: (ms % 1000) * 1_000_000
  };
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}

/** Prisma unique-constraint violation (duck-typed — no client import). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

@Injectable()
export class CatalogService {
  private readonly repository: CatalogRepository;
  private readonly reservationTtlSec: number;
  private readonly now: () => Date;

  constructor(deps: CatalogServiceDeps) {
    this.repository = deps.repository;
    this.reservationTtlSec = deps.reservationTtlSec ?? 900;
    this.now = deps.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------
  // public reads: no caller required
  // ---------------------------------------------------------------------

  /** limit must be within 1..100, offset >= 0 → else INVALID_ARGUMENT. */
  async listBooks(request: ListBooksRequest): Promise<ListBooksResponse> {
    // proto3 implicit presence: a literal `offset: 0` is never serialized on
    // the wire and the field arrives absent — normalize to the default.
    const offset = request.offset ?? 0;
    this.assertPage(offset, request.limit);
    const { books, total } = await this.repository.listBooks({
      offset,
      limit: request.limit
    });
    return { books: await this.mapBooks(books), total };
  }

  /** Same pagination rules; query/genre optional. */
  async searchBooks(request: SearchBooksRequest): Promise<SearchBooksResponse> {
    const offset = request.offset ?? 0;
    this.assertPage(offset, request.limit);
    const { books, total } = await this.repository.searchBooks({
      query: request.query,
      genre: request.genre,
      offset,
      limit: request.limit
    });
    return { books: await this.mapBooks(books), total };
  }

  /** NOT_FOUND when the id does not exist. Deleted books are returned. */
  async getBook(request: GetBookRequest): Promise<GetBookResponse> {
    const book = await this.repository.findBookById(request.bookId);
    if (!book) {
      throw rpcError(status.NOT_FOUND, `book ${request.bookId} not found`);
    }
    const [mapped] = await this.mapBooks([book]);
    return { book: mapped };
  }

  /**
   * NOT_FOUND when ANY id is missing; deleted books ARE returned
   * (is_deleted=true, available=0).
   */
  async getBooksByIds(
    request: GetBooksByIdsRequest
  ): Promise<GetBooksByIdsResponse> {
    const found = await this.repository.findBooksByIds(request.bookIds);
    const byId = new Map(found.map((book) => [book.id, book]));
    const missing = request.bookIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw rpcError(
        status.NOT_FOUND,
        `books not found: ${missing.join(", ")}`
      );
    }
    const ordered = request.bookIds.map((id) => byId.get(id)!);
    return { books: await this.mapBooks(ordered) };
  }

  // ---------------------------------------------------------------------
  // writes: caller = verified JWT context (null → UNAUTHENTICATED)
  // ---------------------------------------------------------------------

  /** Roles EMPLOYER|ADMIN. ALREADY_EXISTS on duplicate isbn. */
  async createBook(
    request: CreateBookRequest,
    caller: UserContext | null
  ): Promise<CreateBookResponse> {
    this.requireRole(caller, [UserRole.Employer, UserRole.Admin]);
    const book = this.validateNewBook(request);
    if (book.isbn) {
      const existing = await this.repository.findBookByIsbn(book.isbn);
      if (existing) {
        throw rpcError(
          status.ALREADY_EXISTS,
          `isbn ${book.isbn} already exists`
        );
      }
    }
    try {
      const created = await this.repository.createBookWithOutbox(
        book,
        (record) => this.bookCreatedEvent(record)
      );
      const [mapped] = await this.mapBooks([created]);
      return { book: mapped };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw rpcError(
          status.ALREADY_EXISTS,
          `isbn ${book.isbn} already exists`
        );
      }
      throw error;
    }
  }

  /** Roles EMPLOYER|ADMIN. NOT_FOUND for missing id. */
  async updateBook(
    request: UpdateBookRequest,
    caller: UserContext | null
  ): Promise<UpdateBookResponse> {
    this.requireRole(caller, [UserRole.Employer, UserRole.Admin]);
    const patch = this.validatePatch(request);
    if (patch.isbn) {
      const existing = await this.repository.findBookByIsbn(patch.isbn);
      if (existing && existing.id !== request.bookId) {
        throw rpcError(
          status.ALREADY_EXISTS,
          `isbn ${patch.isbn} already exists`
        );
      }
    }
    let updated: BookRecord | null;
    try {
      updated = await this.repository.updateBookWithOutbox(
        request.bookId,
        patch,
        this.now(),
        (record) => this.bookUpdatedEvent(record)
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw rpcError(
          status.ALREADY_EXISTS,
          `isbn ${patch.isbn} already exists`
        );
      }
      if (error instanceof StockBelowReservedError) {
        // spec §8: state prevents the operation — lowering stock below live
        // reservations would break a later CommitStock
        throw rpcError(
          status.FAILED_PRECONDITION,
          `stock for book ${request.bookId} cannot be lowered below ` +
            `${error.reserved} active reservations`
        );
      }
      throw error;
    }
    if (!updated) {
      throw rpcError(status.NOT_FOUND, `book ${request.bookId} not found`);
    }
    const [mapped] = await this.mapBooks([updated]);
    return { book: mapped };
  }

  /** Role ADMIN only. Soft delete — the book stays visible in reads. */
  async deleteBook(
    request: DeleteBookRequest,
    caller: UserContext | null
  ): Promise<DeleteBookResponse> {
    this.requireRole(caller, [UserRole.Admin]);
    const deleted = await this.repository.softDeleteBookWithOutbox(
      request.bookId,
      this.now(),
      (record) => this.bookDeletedEvent(record)
    );
    if (!deleted) {
      throw rpcError(status.NOT_FOUND, `book ${request.bookId} not found`);
    }
    return {};
  }

  /**
   * Role ADMIN only. Single atomic conditional update in the repository —
   * FAILED_PRECONDITION when the book is not deleted, NOT_FOUND when it
   * does not exist.
   */
  async restoreBook(
    request: RestoreBookRequest,
    caller: UserContext | null
  ): Promise<RestoreBookResponse> {
    this.requireRole(caller, [UserRole.Admin]);
    const restored = await this.repository.restoreBook(request.bookId);
    if (restored === "not_found") {
      throw rpcError(status.NOT_FOUND, `book ${request.bookId} not found`);
    }
    if (restored === "not_deleted") {
      throw rpcError(
        status.FAILED_PRECONDITION,
        `book ${request.bookId} is not deleted`
      );
    }
    const [mapped] = await this.mapBooks([restored]);
    return { book: mapped };
  }

  // ---------------------------------------------------------------------
  // stock orchestration: any valid JWT (order-service proxy)
  // ---------------------------------------------------------------------

  /**
   * All-or-nothing reservation with TTL. NOT_FOUND for unknown book ids;
   * FAILED_PRECONDITION (unavailable ids in error details) for deleted or
   * insufficient stock; INVALID_ARGUMENT for empty items / amount < 1.
   */
  async reserveStock(
    request: ReserveStockRequest,
    caller: UserContext | null
  ): Promise<ReserveStockResponse> {
    this.requireCaller(caller);
    if (!request.items || request.items.length === 0) {
      throw rpcError(
        status.INVALID_ARGUMENT,
        "items must contain at least one position"
      );
    }
    // Aggregate duplicates per book_id BEFORE the repository call: each
    // item.amount is a valid int32 on its own, but their sum can overflow
    // int4 — reservation_items.amount and the guarded stock UPDATE both
    // assume the per-book aggregate fits (F-C2).
    const totalsByBook = new Map<string, number>();
    for (const item of request.items) {
      if (!Number.isInteger(item.amount) || item.amount < 1) {
        throw rpcError(
          status.INVALID_ARGUMENT,
          `amount for book ${item.bookId} must be a positive integer`
        );
      }
      const total = (totalsByBook.get(item.bookId) ?? 0) + item.amount;
      if (total > MAX_INT32) {
        throw rpcError(
          status.INVALID_ARGUMENT,
          `total amount for book ${item.bookId} exceeds ${MAX_INT32}`
        );
      }
      totalsByBook.set(item.bookId, total);
    }
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.reservationTtlSec * 1000);
    const result = await this.repository.reserveStockAtomic(
      request.items.map((item) => ({
        bookId: item.bookId,
        amount: item.amount
      })),
      expiresAt,
      now
    );
    if (!result.ok) {
      if (result.missing.length > 0) {
        throw rpcError(
          status.NOT_FOUND,
          `books not found: ${result.missing.join(", ")}`
        );
      }
      throw rpcError(
        status.FAILED_PRECONDITION,
        `books unavailable for reservation: ${result.unavailable.join(", ")}`
      );
    }
    return {
      reservationId: result.reservation.id,
      expiresAt: toTimestamp(result.reservation.expiresAt)
    };
  }

  /** Idempotent: COMMITTED → success without double decrement. */
  async commitStock(
    request: CommitStockRequest,
    caller: UserContext | null
  ): Promise<CommitStockResponse> {
    this.requireCaller(caller);
    const result = await this.repository.commitReservation(
      request.reservationId,
      this.now()
    );
    if (result === "not_found") {
      throw rpcError(
        status.NOT_FOUND,
        `reservation ${request.reservationId} not found or expired`
      );
    }
    if (result === "insufficient_stock") {
      // stock moved below the reserved amount since ReserveStock — the
      // guarded decrement refused rather than driving stock negative
      throw rpcError(
        status.FAILED_PRECONDITION,
        `reservation ${request.reservationId} cannot be committed: ` +
          "stock no longer covers the reserved amount"
      );
    }
    return {};
  }

  /**
   * NOT_FOUND for missing/expired reservations; FAILED_PRECONDITION for
   * COMMITTED or already-RELEASED ones.
   */
  async releaseStock(
    request: ReleaseStockRequest,
    caller: UserContext | null
  ): Promise<ReleaseStockResponse> {
    this.requireCaller(caller);
    const result = await this.repository.releaseReservation(
      request.reservationId,
      this.now()
    );
    if (result === "not_found") {
      throw rpcError(
        status.NOT_FOUND,
        `reservation ${request.reservationId} not found or expired`
      );
    }
    if (result === "invalid_state") {
      throw rpcError(
        status.FAILED_PRECONDITION,
        `reservation ${request.reservationId} cannot be released`
      );
    }
    return {};
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private requireCaller(caller: UserContext | null): UserContext {
    if (!caller) {
      throw rpcError(
        status.UNAUTHENTICATED,
        "missing or invalid authentication token"
      );
    }
    return caller;
  }

  private requireRole(
    caller: UserContext | null,
    roles: UserRole[]
  ): UserContext {
    const user = this.requireCaller(caller);
    if (!roles.includes(user.role)) {
      throw rpcError(
        status.PERMISSION_DENIED,
        `role ${user.role} is not allowed to perform this operation`
      );
    }
    return user;
  }

  private assertPage(offset: number, limit: number): void {
    if (!Number.isInteger(offset) || offset < 0) {
      throw rpcError(
        status.INVALID_ARGUMENT,
        "offset must be a non-negative integer"
      );
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw rpcError(
        status.INVALID_ARGUMENT,
        `limit must be an integer between 1 and ${MAX_LIMIT}`
      );
    }
  }

  private assertNonEmpty(value: string, field: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw rpcError(
        status.INVALID_ARGUMENT,
        `${field} must be a non-empty string`
      );
    }
  }

  private assertPrice(price: number): void {
    if (!Number.isFinite(price) || price < 0 || price > MAX_PRICE) {
      throw rpcError(
        status.INVALID_ARGUMENT,
        `price must be a finite number between 0 and ${MAX_PRICE}`
      );
    }
  }

  private assertStock(stock: number): void {
    if (!Number.isInteger(stock) || stock < 0 || stock > MAX_INT32) {
      throw rpcError(
        status.INVALID_ARGUMENT,
        `stock must be an integer between 0 and ${MAX_INT32}`
      );
    }
  }

  private assertYear(year: number | null | undefined): void {
    if (year === undefined || year === null) {
      return;
    }
    const maxYear = this.now().getFullYear() + 1;
    if (!Number.isInteger(year) || year < 0 || year > maxYear) {
      throw rpcError(
        status.INVALID_ARGUMENT,
        `year must be an integer between 0 and ${maxYear}`
      );
    }
  }

  private validateNewBook(request: CreateBookRequest): NewBook {
    this.assertNonEmpty(request.bookName, "book_name");
    this.assertNonEmpty(request.author, "author");
    this.assertPrice(request.price);
    this.assertStock(request.stock);
    this.assertYear(request.year);
    return {
      bookName: request.bookName,
      author: request.author,
      isbn: emptyToNull(request.isbn),
      description: emptyToNull(request.description),
      genre: emptyToNull(request.genre),
      year: request.year ?? null,
      coverUrl: emptyToNull(request.coverUrl),
      price: request.price,
      stock: request.stock
    };
  }

  private validatePatch(request: UpdateBookRequest): BookPatch {
    const patch: BookPatch = {};
    if (request.bookName !== undefined) {
      this.assertNonEmpty(request.bookName, "book_name");
      patch.bookName = request.bookName;
    }
    if (request.author !== undefined) {
      this.assertNonEmpty(request.author, "author");
      patch.author = request.author;
    }
    if (request.price !== undefined) {
      this.assertPrice(request.price);
      patch.price = request.price;
    }
    if (request.stock !== undefined) {
      this.assertStock(request.stock);
      patch.stock = request.stock;
    }
    if (request.year !== undefined) {
      this.assertYear(request.year);
      patch.year = request.year;
    }
    if (request.isbn !== undefined) {
      patch.isbn = emptyToNull(request.isbn);
    }
    if (request.description !== undefined) {
      patch.description = emptyToNull(request.description);
    }
    if (request.genre !== undefined) {
      patch.genre = emptyToNull(request.genre);
    }
    if (request.coverUrl !== undefined) {
      patch.coverUrl = emptyToNull(request.coverUrl);
    }
    return patch;
  }

  /** available = stock − live reservations; always 0 for deleted books. */
  private async mapBooks(records: BookRecord[]): Promise<Book[]> {
    const reserved = await this.repository.sumActiveReserved(
      records.map((book) => book.id),
      this.now()
    );
    return records.map((book) => this.toProto(book, reserved[book.id] ?? 0));
  }

  private toProto(book: BookRecord, reserved: number): Book {
    const isDeleted = book.deletedAt !== null;
    return {
      bookId: book.id,
      bookName: book.bookName,
      author: book.author,
      isbn: book.isbn ?? undefined,
      description: book.description ?? undefined,
      genre: book.genre ?? undefined,
      year: book.year ?? undefined,
      coverUrl: book.coverUrl ?? undefined,
      price: book.price,
      stock: book.stock,
      available: isDeleted ? 0 : Math.max(0, book.stock - reserved),
      isDeleted,
      createdAt: toTimestamp(book.createdAt),
      updatedAt: toTimestamp(book.updatedAt)
    };
  }

  private bookCreatedEvent(record: BookRecord) {
    const payload: BookCreatedPayload = {
      bookId: record.id,
      bookName: record.bookName,
      author: record.author,
      price: record.price
    };
    return { eventType: EVENT_TYPES.bookCreated, payload };
  }

  private bookUpdatedEvent(record: BookRecord) {
    const payload: BookUpdatedPayload = {
      bookId: record.id,
      bookName: record.bookName,
      author: record.author,
      price: record.price
    };
    return { eventType: EVENT_TYPES.bookUpdated, payload };
  }

  private bookDeletedEvent(record: BookRecord) {
    const payload: BookDeletedPayload = { bookId: record.id };
    return { eventType: EVENT_TYPES.bookDeleted, payload };
  }
}
