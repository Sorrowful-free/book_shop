// Service contract — types only, no runtime code (TDD phase).
//
// `declare class` gives the test-suite a compile-time surface (constructor +
// method signatures) while emitting nothing at runtime: `new CatalogService()`
// fails, which is exactly what the failing tests assert against until the
// implementation phase provides the real NestJS service.
//
// Error contract (spec §8): methods reject with errors carrying a numeric
// gRPC `code` (INVALID_ARGUMENT / ALREADY_EXISTS / NOT_FOUND /
// FAILED_PRECONDITION / UNAUTHENTICATED / PERMISSION_DENIED).

import type { UserContext } from "@book-shop/common";
import type {
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
import type { CatalogRepository } from "./repository";

export interface CatalogServiceDeps {
  repository: CatalogRepository;
  /** Reservation TTL in seconds (env RESERVATION_TTL_SEC, default 900). */
  reservationTtlSec?: number;
  /** Injectable clock — lets unit tests expire reservations deterministically. */
  now?: () => Date;
}

export declare class CatalogService {
  constructor(deps: CatalogServiceDeps);

  // ---- public reads: no caller required ----

  /** limit must be within 1..100, offset >= 0 → else INVALID_ARGUMENT. */
  listBooks(request: ListBooksRequest): Promise<ListBooksResponse>;

  /** Same pagination rules; query/genre optional. */
  searchBooks(request: SearchBooksRequest): Promise<SearchBooksResponse>;

  /** NOT_FOUND when the id does not exist. Deleted books are returned. */
  getBook(request: GetBookRequest): Promise<GetBookResponse>;

  /**
   * NOT_FOUND when ANY id is missing; deleted books ARE returned
   * (is_deleted=true, available=0).
   */
  getBooksByIds(request: GetBooksByIdsRequest): Promise<GetBooksByIdsResponse>;

  // ---- writes: caller = verified JWT context (null → UNAUTHENTICATED) ----

  /** Roles EMPLOYER|ADMIN. ALREADY_EXISTS on duplicate isbn. */
  createBook(
    request: CreateBookRequest,
    caller: UserContext | null
  ): Promise<CreateBookResponse>;

  /** Roles EMPLOYER|ADMIN. NOT_FOUND for missing id. */
  updateBook(
    request: UpdateBookRequest,
    caller: UserContext | null
  ): Promise<UpdateBookResponse>;

  /** Role ADMIN only. Soft delete — the book stays visible in reads. */
  deleteBook(
    request: DeleteBookRequest,
    caller: UserContext | null
  ): Promise<DeleteBookResponse>;

  /** Role ADMIN only. FAILED_PRECONDITION when the book is not deleted. */
  restoreBook(
    request: RestoreBookRequest,
    caller: UserContext | null
  ): Promise<RestoreBookResponse>;

  // ---- stock orchestration: any valid JWT (order-service proxy) ----

  /**
   * All-or-nothing reservation with TTL. NOT_FOUND for unknown book ids;
   * FAILED_PRECONDITION (unavailable ids in error details) for deleted or
   * insufficient stock; INVALID_ARGUMENT for empty items / amount < 1.
   */
  reserveStock(
    request: ReserveStockRequest,
    caller: UserContext | null
  ): Promise<ReserveStockResponse>;

  /** Idempotent: COMMITTED → success without double decrement. */
  commitStock(
    request: CommitStockRequest,
    caller: UserContext | null
  ): Promise<CommitStockResponse>;

  /**
   * NOT_FOUND for missing/expired reservations; FAILED_PRECONDITION for
   * COMMITTED or already-RELEASED ones.
   */
  releaseStock(
    request: ReleaseStockRequest,
    caller: UserContext | null
  ): Promise<ReleaseStockResponse>;
}
