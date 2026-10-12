// Prisma-backed CatalogRepository — the production adapter for
// catalog_db (spec §3). Mutations that emit domain events run the entity
// write AND the outbox insert inside ONE prisma transaction; reservation
// flows lock rows (`SELECT … FOR UPDATE`) inside their transaction.

import { Injectable } from "@nestjs/common";
import { Prisma } from "./generated/prisma";
import type {
  Book as PrismaBook,
  Reservation as PrismaReservation,
  ReservationItem as PrismaReservationItem
} from "./generated/prisma";
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
  ReservationRecord,
  ReservationStatus,
  ReserveResult,
  RestoreResult,
  SearchRequest
} from "./repository";
import { StockBelowReservedError } from "./repository";
import { PrismaService } from "./prisma.service";

function toBookRecord(book: PrismaBook): BookRecord {
  return {
    id: book.id,
    bookName: book.bookName,
    author: book.author,
    isbn: book.isbn,
    description: book.description,
    genre: book.genre,
    year: book.year,
    coverUrl: book.coverUrl,
    price: Number(book.price),
    stock: book.stock,
    deletedAt: book.deletedAt,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt
  };
}

function toReservationRecord(
  reservation: PrismaReservation & { items: PrismaReservationItem[] }
): ReservationRecord {
  return {
    id: reservation.id,
    status: reservation.status as ReservationStatus,
    expiresAt: reservation.expiresAt,
    items: reservation.items.map((item) => ({
      bookId: item.bookId,
      amount: item.amount
    })),
    createdAt: reservation.createdAt
  };
}

function patchToData(patch: BookPatch): Prisma.BookUpdateInput {
  const data: Prisma.BookUpdateInput = {};
  if (patch.bookName !== undefined) {
    data.bookName = patch.bookName;
  }
  if (patch.author !== undefined) {
    data.author = patch.author;
  }
  if (patch.isbn !== undefined) {
    data.isbn = patch.isbn;
  }
  if (patch.description !== undefined) {
    data.description = patch.description;
  }
  if (patch.genre !== undefined) {
    data.genre = patch.genre;
  }
  if (patch.year !== undefined) {
    data.year = patch.year;
  }
  if (patch.coverUrl !== undefined) {
    data.coverUrl = patch.coverUrl;
  }
  if (patch.price !== undefined) {
    data.price = new Prisma.Decimal(patch.price);
  }
  if (patch.stock !== undefined) {
    data.stock = patch.stock;
  }
  return data;
}

interface LockedBookRow {
  id: string;
  stock: number;
  deletedAt: Date | null;
}

interface HeldRow {
  bookId: string;
  total: number | bigint;
}

interface ReservationRow {
  id: string;
  status: string;
  expiresAt: Date;
}

/**
 * Sentinel thrown inside the commit transaction when a guarded stock
 * decrement affects 0 rows — throwing (not returning) is what rolls back
 * the partial decrements made for earlier items.
 */
class StockGuardError extends Error {
  constructor(public readonly bookId: string) {
    super(`stock guard failed for book ${bookId}`);
    this.name = "StockGuardError";
  }
}

@Injectable()
export class PrismaCatalogRepository implements CatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- reads (public RPCs) ----

  async listBooks(
    page: PageRequest
  ): Promise<{ books: BookRecord[]; total: number }> {
    const [books, total] = await this.prisma.$transaction([
      this.prisma.book.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: page.offset,
        take: page.limit
      }),
      this.prisma.book.count()
    ]);
    return { books: books.map(toBookRecord), total };
  }

  async searchBooks(
    search: SearchRequest
  ): Promise<{ books: BookRecord[]; total: number }> {
    const where: Prisma.BookWhereInput = {};
    const conditions: Prisma.BookWhereInput[] = [];
    if (search.query !== undefined && search.query !== "") {
      conditions.push({
        OR: [
          { bookName: { contains: search.query, mode: "insensitive" } },
          { author: { contains: search.query, mode: "insensitive" } }
        ]
      });
    }
    if (search.genre !== undefined && search.genre !== "") {
      conditions.push({ genre: search.genre });
    }
    if (conditions.length > 0) {
      where.AND = conditions;
    }
    const [books, total] = await this.prisma.$transaction([
      this.prisma.book.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: search.offset,
        take: search.limit
      }),
      this.prisma.book.count({ where })
    ]);
    return { books: books.map(toBookRecord), total };
  }

  async findBookById(id: string): Promise<BookRecord | null> {
    const book = await this.prisma.book.findUnique({ where: { id } });
    return book ? toBookRecord(book) : null;
  }

  /** Returns only the found books — the service decides missing → NOT_FOUND. */
  async findBooksByIds(ids: string[]): Promise<BookRecord[]> {
    const books = await this.prisma.book.findMany({
      where: { id: { in: ids } }
    });
    return books.map(toBookRecord);
  }

  async findBookByIsbn(isbn: string): Promise<BookRecord | null> {
    const book = await this.prisma.book.findUnique({ where: { isbn } });
    return book ? toBookRecord(book) : null;
  }

  /**
   * Sum of amounts held by ACTIVE, non-expired (expires_at > now) reservations
   * per book. Used to compute `available = stock − active_reservations`.
   */
  async sumActiveReserved(
    bookIds: string[],
    now: Date
  ): Promise<Record<string, number>> {
    if (bookIds.length === 0) {
      return {};
    }
    const rows = await this.prisma.reservationItem.groupBy({
      by: ["bookId"],
      where: {
        bookId: { in: bookIds },
        reservation: { status: "ACTIVE", expiresAt: { gt: now } }
      },
      _sum: { amount: true }
    });
    const sums: Record<string, number> = {};
    for (const row of rows) {
      sums[row.bookId] = row._sum.amount ?? 0;
    }
    return sums;
  }

  // ---- writes (mutation + outbox row in ONE transaction) ----

  async createBookWithOutbox(
    book: NewBook,
    buildEvent: (created: BookRecord) => OutboxEventInput
  ): Promise<BookRecord> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.book.create({
        data: {
          bookName: book.bookName,
          author: book.author,
          isbn: book.isbn ?? null,
          description: book.description ?? null,
          genre: book.genre ?? null,
          year: book.year ?? null,
          coverUrl: book.coverUrl ?? null,
          price: new Prisma.Decimal(book.price),
          stock: book.stock
        }
      });
      const record = toBookRecord(created);
      await this.insertOutbox(tx, buildEvent(record));
      return record;
    });
  }

  async updateBookWithOutbox(
    id: string,
    patch: BookPatch,
    now: Date,
    buildEvent: (updated: BookRecord) => OutboxEventInput
  ): Promise<BookRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      // Lock the book row first: the stock-vs-reservations check below must
      // be stable against reserveStockAtomic, which takes the same
      // FOR UPDATE lock before inserting reservation items.
      const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM books WHERE id = ${id} FOR UPDATE`);
      if (locked.length === 0) {
        return null;
      }
      if (patch.stock !== undefined) {
        const held = await tx.$queryRaw<
          { total: number | bigint }[]
        >(Prisma.sql`
          SELECT COALESCE(SUM(ri.amount), 0)::int AS total
          FROM reservation_items ri
          JOIN reservations r ON r.id = ri.reservation_id
          WHERE ri.book_id = ${id}
            AND r.status = 'ACTIVE'
            AND r.expires_at > ${now}`);
        const reserved = Number(held[0]?.total ?? 0);
        if (patch.stock < reserved) {
          throw new StockBelowReservedError(id, reserved);
        }
      }
      const updated = await tx.book.update({
        where: { id },
        data: patchToData(patch)
      });
      const record = toBookRecord(updated);
      await this.insertOutbox(tx, buildEvent(record));
      return record;
    });
  }

  /** Soft delete: sets deleted_at. Emits catalog.book.deleted. */
  async softDeleteBookWithOutbox(
    id: string,
    deletedAt: Date,
    buildEvent: (book: BookRecord) => OutboxEventInput
  ): Promise<BookRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.book.findUnique({ where: { id } });
      if (!existing) {
        return null;
      }
      const updated = await tx.book.update({
        where: { id },
        data: { deletedAt }
      });
      const record = toBookRecord(updated);
      await this.insertOutbox(tx, buildEvent(record));
      return record;
    });
  }

  /**
   * Single conditional UPDATE (`deleted_at IS NOT NULL`) — the
   * "is actually deleted" check and the restore are atomic (no TOCTOU).
   * Affected 0 → classify with a follow-up read (error path only).
   */
  async restoreBook(id: string): Promise<RestoreResult> {
    const updated = await this.prisma.book.updateMany({
      where: { id, deletedAt: { not: null } },
      data: { deletedAt: null, updatedAt: new Date() }
    });
    if (updated.count > 0) {
      const restored = await this.prisma.book.findUnique({ where: { id } });
      return restored ? toBookRecord(restored) : "not_found";
    }
    const existing = await this.prisma.book.findUnique({ where: { id } });
    return existing ? "not_deleted" : "not_found";
  }

  // ---- reservations ----

  /**
   * Atomic all-or-nothing reservation: book rows are locked FOR UPDATE
   * one-by-one in ascending id order (Postgres locks in scan order — an
   * `IN (…) ORDER BY …` clause does NOT order lock acquisition, so
   * per-id statements in a fixed order are what actually prevents
   * deadlocks), every position is checked for `is_deleted` and
   * `stock − live reservations >= amount`, and only then is the
   * reservation inserted — all inside one transaction.
   */
  async reserveStockAtomic(
    items: ReservationItemInput[],
    expiresAt: Date,
    now: Date
  ): Promise<ReserveResult> {
    const wanted = new Map<string, number>();
    for (const item of items) {
      wanted.set(item.bookId, (wanted.get(item.bookId) ?? 0) + item.amount);
    }
    const ids = [...wanted.keys()].sort();
    return this.prisma.$transaction(async (tx): Promise<ReserveResult> => {
      const byId = new Map<string, LockedBookRow>();
      for (const id of ids) {
        const books = await tx.$queryRaw<LockedBookRow[]>(Prisma.sql`
          SELECT id, stock, deleted_at AS "deletedAt"
          FROM books
          WHERE id = ${id}
          FOR UPDATE`);
        if (books[0]) {
          byId.set(id, books[0]);
        }
      }
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        return { ok: false, missing, unavailable: [] };
      }
      const held = await tx.$queryRaw<HeldRow[]>(Prisma.sql`
        SELECT ri.book_id AS "bookId", SUM(ri.amount)::int AS total
        FROM reservation_items ri
        JOIN reservations r ON r.id = ri.reservation_id
        WHERE ri.book_id IN (${Prisma.join(ids)})
          AND r.status = 'ACTIVE'
          AND r.expires_at > ${now}
        GROUP BY ri.book_id`);
      const reserved = new Map(
        held.map((row) => [row.bookId, Number(row.total)])
      );
      const unavailable = ids.filter((id) => {
        const book = byId.get(id)!;
        return (
          book.deletedAt !== null ||
          book.stock - (reserved.get(id) ?? 0) < wanted.get(id)!
        );
      });
      if (unavailable.length > 0) {
        return { ok: false, missing: [], unavailable };
      }
      const created = await tx.reservation.create({
        data: {
          expiresAt,
          items: {
            create: items.map((item) => ({
              bookId: item.bookId,
              amount: item.amount
            }))
          }
        },
        include: { items: true }
      });
      return { ok: true, reservation: toReservationRecord(created) };
    });
  }

  /** Decrements stock and marks the reservation COMMITTED; idempotent. */
  async commitReservation(id: string, now: Date): Promise<CommitResult> {
    try {
      return await this.prisma.$transaction(
        async (tx): Promise<CommitResult> => {
          const rows = await tx.$queryRaw<ReservationRow[]>(Prisma.sql`
            SELECT id, status::text AS status, expires_at AS "expiresAt"
            FROM reservations
            WHERE id = ${id}
            FOR UPDATE`);
          const reservation = rows[0];
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
            // released, marked-expired or lazily-expired reservations collapse
            return "not_found";
          }
          const items = await tx.reservationItem.findMany({
            where: { reservationId: id },
            orderBy: { bookId: "asc" }
          });
          for (const item of items) {
            // Guarded decrement: stock >= amount keeps the books.stock >= 0
            // invariant even if stock moved since ReserveStock. A failed
            // guard throws → the whole transaction rolls back (no partial
            // decrements, reservation stays ACTIVE).
            const affected = await tx.$executeRaw(Prisma.sql`
              UPDATE books
              SET stock = stock - ${item.amount}, updated_at = ${now}
              WHERE id = ${item.bookId} AND stock >= ${item.amount}`);
            if (affected === 0) {
              throw new StockGuardError(item.bookId);
            }
          }
          await tx.reservation.update({
            where: { id },
            data: { status: "COMMITTED" }
          });
          return "committed";
        }
      );
    } catch (error) {
      if (error instanceof StockGuardError) {
        return "insufficient_stock";
      }
      throw error;
    }
  }

  /** Marks the reservation RELEASED (availability is freed implicitly). */
  async releaseReservation(id: string, now: Date): Promise<ReleaseResult> {
    return this.prisma.$transaction(async (tx): Promise<ReleaseResult> => {
      const rows = await tx.$queryRaw<ReservationRow[]>(Prisma.sql`
        SELECT id, status::text AS status, expires_at AS "expiresAt"
        FROM reservations
        WHERE id = ${id}
        FOR UPDATE`);
      const reservation = rows[0];
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
      await tx.reservation.update({
        where: { id },
        data: { status: "RELEASED" }
      });
      return "released";
    });
  }

  private async insertOutbox(
    tx: Prisma.TransactionClient,
    event: OutboxEventInput
  ): Promise<void> {
    await tx.outbox.create({
      data: {
        eventType: event.eventType,
        payload: event.payload as Prisma.InputJsonValue
      }
    });
  }
}
