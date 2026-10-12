// Repository contract — types only, no runtime code (TDD phase).
// The implementation phase provides a Prisma-backed CatalogRepository;
// unit tests substitute an in-memory test double. All write methods that
// publish domain events take a `buildEvent` callback so the mutation and
// the outbox row land in ONE database transaction (see spec §4).

import type { EventType } from "@book-shop/contracts";

export type ReservationStatus = "ACTIVE" | "COMMITTED" | "RELEASED" | "EXPIRED";

export interface BookRecord {
  id: string;
  bookName: string;
  author: string;
  isbn: string | null;
  description: string | null;
  genre: string | null;
  year: number | null;
  coverUrl: string | null;
  /** Decimal(10,2) at rest; plain number across the repository boundary. */
  price: number;
  /** Raw stock on hand (reservations are NOT subtracted here). */
  stock: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PageRequest {
  offset: number;
  limit: number;
}

export interface SearchRequest extends PageRequest {
  /** Substring match on book_name/author, case-insensitive. */
  query?: string;
  /** Exact genre filter. */
  genre?: string;
}

export interface NewBook {
  bookName: string;
  author: string;
  isbn?: string | null;
  description?: string | null;
  genre?: string | null;
  year?: number | null;
  coverUrl?: string | null;
  price: number;
  stock: number;
}

/** Only defined fields are applied. */
export type BookPatch = Partial<NewBook>;

export interface ReservationItemInput {
  bookId: string;
  amount: number;
}

export interface ReservationItemRecord {
  bookId: string;
  amount: number;
}

export interface ReservationRecord {
  id: string;
  status: ReservationStatus;
  expiresAt: Date;
  items: ReservationItemRecord[];
  createdAt: Date;
}

export interface OutboxEventInput {
  eventType: EventType;
  payload: unknown;
}

/**
 * Atomic check-and-insert for ReserveStock (single transaction, row locks).
 * - `missing`: some book_id does not exist at all → service maps NOT_FOUND.
 * - `unavailable`: book is deleted or stock − active reservations < amount →
 *   service maps FAILED_PRECONDITION and SHOULD surface these ids in details.
 * Nothing is persisted unless `ok` is true.
 */
export type ReserveResult =
  | { ok: true; reservation: ReservationRecord }
  | { ok: false; missing: string[]; unavailable: string[] };

/**
 * CommitStock must be idempotent: committing an already-COMMITTED reservation
 * succeeds without decrementing stock twice. Missing, released and expired
 * (ACTIVE with expires_at <= now) reservations all collapse to `not_found`.
 */
export type CommitResult = "committed" | "already_committed" | "not_found";

/**
 * ReleaseStock: only a live ACTIVE reservation can be released.
 * `invalid_state` covers COMMITTED and already-RELEASED → FAILED_PRECONDITION;
 * missing/expired reservations return `not_found`.
 */
export type ReleaseResult = "released" | "invalid_state" | "not_found";

export interface CatalogRepository {
  // ---- reads (public RPCs) ----
  listBooks(page: PageRequest): Promise<{ books: BookRecord[]; total: number }>;
  searchBooks(
    search: SearchRequest
  ): Promise<{ books: BookRecord[]; total: number }>;
  findBookById(id: string): Promise<BookRecord | null>;
  /** Returns only the found books — the service decides missing → NOT_FOUND. */
  findBooksByIds(ids: string[]): Promise<BookRecord[]>;
  findBookByIsbn(isbn: string): Promise<BookRecord | null>;

  /**
   * Sum of amounts held by ACTIVE, non-expired (expires_at > now) reservations
   * per book. Used to compute `available = stock − active_reservations`.
   */
  sumActiveReserved(
    bookIds: string[],
    now: Date
  ): Promise<Record<string, number>>;

  // ---- writes (mutation + outbox row in ONE transaction) ----
  createBookWithOutbox(
    book: NewBook,
    buildEvent: (created: BookRecord) => OutboxEventInput
  ): Promise<BookRecord>;
  updateBookWithOutbox(
    id: string,
    patch: BookPatch,
    buildEvent: (updated: BookRecord) => OutboxEventInput
  ): Promise<BookRecord | null>;
  /** Soft delete: sets deleted_at. Emits catalog.book.deleted. */
  softDeleteBookWithOutbox(
    id: string,
    deletedAt: Date,
    buildEvent: (book: BookRecord) => OutboxEventInput
  ): Promise<BookRecord | null>;
  /** Clears deleted_at. Publishes NO event. */
  restoreBook(id: string): Promise<BookRecord | null>;

  // ---- reservations ----
  /** Atomic all-or-nothing reservation; see ReserveResult. */
  reserveStockAtomic(
    items: ReservationItemInput[],
    expiresAt: Date,
    now: Date
  ): Promise<ReserveResult>;
  /** Decrements stock and marks the reservation COMMITTED; idempotent. */
  commitReservation(id: string, now: Date): Promise<CommitResult>;
  /** Marks the reservation RELEASED (availability is freed implicitly). */
  releaseReservation(id: string, now: Date): Promise<ReleaseResult>;
}
