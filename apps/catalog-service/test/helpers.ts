// Shared unit-test kit: an in-memory CatalogRepository test double, the
// service harness and gRPC-error matchers. Lives in test/ (not src/) — it is
// a test double, not an implementation. The real Prisma-backed repository is
// built in the implementation phase.

import { randomUUID } from "node:crypto";
import { expect } from "bun:test";
import { status } from "@grpc/grpc-js";
import type { UserContext } from "@book-shop/common";
import { UserRole } from "@book-shop/contracts";
import { CatalogService } from "../src/catalog.service";
import type {
  BookPatch,
  BookRecord,
  CatalogRepository,
  CommitResult,
  NewBook,
  OutboxEventInput,
  PageRequest,
  ReleaseResult,
  ReservationItemInput,
  ReservationItemRecord,
  ReservationRecord,
  ReserveResult,
  SearchRequest
} from "../src/repository";

// ---------------------------------------------------------------------------
// In-memory CatalogRepository test double
// ---------------------------------------------------------------------------

export class InMemoryCatalogRepository implements CatalogRepository {
  books = new Map<string, BookRecord>();
  reservations = new Map<string, ReservationRecord>();
  outbox: OutboxEventInput[] = [];

  private cloneBook(book: BookRecord): BookRecord {
    return { ...book };
  }

  private cloneReservation(reservation: ReservationRecord): ReservationRecord {
    return {
      ...reservation,
      items: reservation.items.map((item) => ({ ...item }))
    };
  }

  private sortedBooks(): BookRecord[] {
    return [...this.books.values()].sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id)
    );
  }

  async listBooks(
    page: PageRequest
  ): Promise<{ books: BookRecord[]; total: number }> {
    const all = this.sortedBooks();
    return {
      books: all
        .slice(page.offset, page.offset + page.limit)
        .map((b) => this.cloneBook(b)),
      total: all.length
    };
  }

  async searchBooks(
    search: SearchRequest
  ): Promise<{ books: BookRecord[]; total: number }> {
    const query = search.query?.toLowerCase();
    const all = this.sortedBooks().filter(
      (book) =>
        (!query ||
          book.bookName.toLowerCase().includes(query) ||
          book.author.toLowerCase().includes(query)) &&
        (search.genre === undefined || book.genre === search.genre)
    );
    return {
      books: all
        .slice(search.offset, search.offset + search.limit)
        .map((b) => this.cloneBook(b)),
      total: all.length
    };
  }

  async findBookById(id: string): Promise<BookRecord | null> {
    const book = this.books.get(id);
    return book ? this.cloneBook(book) : null;
  }

  async findBooksByIds(ids: string[]): Promise<BookRecord[]> {
    return ids
      .map((id) => this.books.get(id))
      .filter((b): b is BookRecord => b !== undefined)
      .map((b) => this.cloneBook(b));
  }

  async findBookByIsbn(isbn: string): Promise<BookRecord | null> {
    const book = [...this.books.values()].find((b) => b.isbn === isbn);
    return book ? this.cloneBook(book) : null;
  }

  async sumActiveReserved(
    bookIds: string[],
    now: Date
  ): Promise<Record<string, number>> {
    const wanted = new Set(bookIds);
    const sums: Record<string, number> = {};
    for (const reservation of this.reservations.values()) {
      if (
        reservation.status !== "ACTIVE" ||
        reservation.expiresAt.getTime() <= now.getTime()
      ) {
        continue;
      }
      for (const item of reservation.items) {
        if (wanted.has(item.bookId)) {
          sums[item.bookId] = (sums[item.bookId] ?? 0) + item.amount;
        }
      }
    }
    return sums;
  }

  async createBookWithOutbox(
    book: NewBook,
    buildEvent: (created: BookRecord) => OutboxEventInput
  ): Promise<BookRecord> {
    const created: BookRecord = {
      id: randomUUID(),
      bookName: book.bookName,
      author: book.author,
      isbn: book.isbn ?? null,
      description: book.description ?? null,
      genre: book.genre ?? null,
      year: book.year ?? null,
      coverUrl: book.coverUrl ?? null,
      price: book.price,
      stock: book.stock,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    // book + outbox row in ONE transaction — single repository call
    this.books.set(created.id, created);
    this.outbox.push(buildEvent(this.cloneBook(created)));
    return this.cloneBook(created);
  }

  async updateBookWithOutbox(
    id: string,
    patch: BookPatch,
    buildEvent: (updated: BookRecord) => OutboxEventInput
  ): Promise<BookRecord | null> {
    const book = this.books.get(id);
    if (!book) {
      return null;
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        (book as unknown as Record<string, unknown>)[key] = value;
      }
    }
    book.updatedAt = new Date();
    this.outbox.push(buildEvent(this.cloneBook(book)));
    return this.cloneBook(book);
  }

  async softDeleteBookWithOutbox(
    id: string,
    deletedAt: Date,
    buildEvent: (book: BookRecord) => OutboxEventInput
  ): Promise<BookRecord | null> {
    const book = this.books.get(id);
    if (!book) {
      return null;
    }
    book.deletedAt = deletedAt;
    book.updatedAt = new Date();
    this.outbox.push(buildEvent(this.cloneBook(book)));
    return this.cloneBook(book);
  }

  async restoreBook(id: string): Promise<BookRecord | null> {
    const book = this.books.get(id);
    if (!book) {
      return null;
    }
    book.deletedAt = null;
    book.updatedAt = new Date();
    return this.cloneBook(book);
  }

  async reserveStockAtomic(
    items: ReservationItemInput[],
    expiresAt: Date,
    now: Date
  ): Promise<ReserveResult> {
    // all-or-nothing: aggregate amounts per book first
    const wanted = new Map<string, number>();
    for (const item of items) {
      wanted.set(item.bookId, (wanted.get(item.bookId) ?? 0) + item.amount);
    }
    const missing = [...wanted.keys()].filter((id) => !this.books.has(id));
    if (missing.length > 0) {
      return { ok: false, missing, unavailable: [] };
    }
    const reserved = await this.sumActiveReserved([...wanted.keys()], now);
    const unavailable = [...wanted.entries()]
      .filter(([bookId, amount]) => {
        const book = this.books.get(bookId)!;
        return (
          book.deletedAt !== null ||
          book.stock - (reserved[bookId] ?? 0) < amount
        );
      })
      .map(([bookId]) => bookId);
    if (unavailable.length > 0) {
      return { ok: false, missing: [], unavailable };
    }
    const reservation: ReservationRecord = {
      id: randomUUID(),
      status: "ACTIVE",
      expiresAt,
      items: items.map((item) => ({ ...item })),
      createdAt: new Date(now.getTime())
    };
    this.reservations.set(reservation.id, reservation);
    return { ok: true, reservation: this.cloneReservation(reservation) };
  }

  async commitReservation(id: string, now: Date): Promise<CommitResult> {
    const reservation = this.reservations.get(id);
    if (!reservation) {
      return "not_found";
    }
    if (reservation.status === "COMMITTED") {
      // idempotent: already committed — succeed without double decrement
      return "already_committed";
    }
    if (
      reservation.status !== "ACTIVE" ||
      reservation.expiresAt.getTime() <= now.getTime()
    ) {
      return "not_found";
    }
    for (const item of reservation.items) {
      const book = this.books.get(item.bookId);
      if (book) {
        book.stock -= item.amount;
      }
    }
    reservation.status = "COMMITTED";
    return "committed";
  }

  async releaseReservation(id: string, now: Date): Promise<ReleaseResult> {
    const reservation = this.reservations.get(id);
    if (!reservation) {
      return "not_found";
    }
    if (
      reservation.status === "COMMITTED" ||
      reservation.status === "RELEASED"
    ) {
      return "invalid_state";
    }
    if (
      reservation.status !== "ACTIVE" ||
      reservation.expiresAt.getTime() <= now.getTime()
    ) {
      return "not_found";
    }
    reservation.status = "RELEASED";
    return "released";
  }
}

// ---------------------------------------------------------------------------
// Factories / harness
// ---------------------------------------------------------------------------

export function makeBook(overrides: Partial<BookRecord> = {}): BookRecord {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    bookName: `Book ${id.slice(0, 8)}`,
    author: "Test Author",
    isbn: null,
    description: null,
    genre: null,
    year: null,
    coverUrl: null,
    price: 10,
    stock: 0,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

export function seedBook(
  repository: InMemoryCatalogRepository,
  overrides: Partial<BookRecord> = {}
): BookRecord {
  const book = makeBook(overrides);
  repository.books.set(book.id, book);
  return book;
}

export function seedReservation(
  repository: InMemoryCatalogRepository,
  overrides: Partial<ReservationRecord> & {
    items: ReservationItemRecord[];
  }
): ReservationRecord {
  const reservation: ReservationRecord = {
    id: randomUUID(),
    status: "ACTIVE",
    expiresAt: new Date(Date.now() + 900_000),
    createdAt: new Date(),
    ...overrides,
    items: overrides.items.map((item) => ({ ...item }))
  };
  repository.reservations.set(reservation.id, reservation);
  return reservation;
}

export function caller(
  role: UserRole,
  userId = `u-${randomUUID().slice(0, 8)}`
): UserContext {
  return { userId, userName: userId, role };
}

export interface HarnessOptions {
  reservationTtlSec?: number;
  now?: () => Date;
}

export function harness(options: HarnessOptions = {}) {
  const repository = new InMemoryCatalogRepository();
  const service = new CatalogService({
    repository,
    reservationTtlSec: options.reservationTtlSec ?? 900,
    now: options.now ?? (() => new Date())
  });
  return { service, repository };
}

// ---------------------------------------------------------------------------
// gRPC error matchers
// ---------------------------------------------------------------------------

export function grpcCode(error: unknown): number | undefined {
  const err = error as {
    code?: number;
    error?: { code?: number };
    getError?: () => { code?: number };
  };
  return err?.code ?? err?.error?.code ?? err?.getError?.()?.code;
}

export async function catchGrpcError(
  promise: Promise<unknown>
): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a gRPC error, but the call succeeded");
}

export async function expectGrpcError(
  promise: Promise<unknown>,
  expected: status
): Promise<void> {
  const error = await catchGrpcError(promise);
  expect(grpcCode(error)).toBe(expected);
}

/** Whether a thrown error mentions `text` in message or serialized details. */
export function errorMentions(error: unknown, text: string): boolean {
  const message =
    typeof (error as { message?: unknown })?.message === "string"
      ? (error as { message: string }).message
      : "";
  if (message.includes(text)) {
    return true;
  }
  try {
    return JSON.stringify(error).includes(text);
  } catch {
    return false;
  }
}
