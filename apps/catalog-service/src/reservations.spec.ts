import { describe, expect, it } from "bun:test";
import { status } from "@grpc/grpc-js";
import { UserRole } from "@book-shop/contracts";
import {
  caller,
  catchGrpcError,
  errorMentions,
  expectGrpcError,
  harness,
  seedBook
} from "../test/helpers";

const CALLER = caller(UserRole.Customer); // any valid JWT — spec §6

describe("ReserveStock", () => {
  it("reserves stock and returns reservation_id + expires_at = now + TTL", async () => {
    const now = new Date("2030-06-01T12:00:00.000Z");
    const { service, repository } = harness({
      reservationTtlSec: 600,
      now: () => now
    });
    const book = seedBook(repository, { stock: 5 });

    const res = await service.reserveStock(
      { items: [{ bookId: book.id, amount: 2 }] },
      CALLER
    );

    expect(res.reservationId).toBeTruthy();
    expect(Number(res.expiresAt?.seconds)).toBe(
      Math.floor(now.getTime() / 1000) + 600
    );

    // availability drops immediately
    const book2 = await service.getBook({ bookId: book.id });
    expect(book2.book?.available).toBe(3);
  });

  it("rejects an empty items list with INVALID_ARGUMENT", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.reserveStock({ items: [] }, CALLER),
      status.INVALID_ARGUMENT
    );
  });

  it.each([0, -3])(
    "rejects amount=%i with INVALID_ARGUMENT",
    async (amount) => {
      const { service, repository } = harness();
      const book = seedBook(repository, { stock: 5 });
      await expectGrpcError(
        service.reserveStock({ items: [{ bookId: book.id, amount }] }, CALLER),
        status.INVALID_ARGUMENT
      );
    }
  );

  it("returns NOT_FOUND for an unknown book id", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.reserveStock(
        { items: [{ bookId: "missing", amount: 1 }] },
        CALLER
      ),
      status.NOT_FOUND
    );
  });

  it("is all-or-nothing: one short position fails everything and names the ids", async () => {
    const { service, repository } = harness();
    const ok = seedBook(repository, { stock: 5 });
    const short = seedBook(repository, { stock: 1 });

    const error = await catchGrpcError(
      service.reserveStock(
        {
          items: [
            { bookId: ok.id, amount: 2 },
            { bookId: short.id, amount: 5 }
          ]
        },
        CALLER
      )
    );
    expect((error as { code?: number }).code).toBe(status.FAILED_PRECONDITION);
    // spec §2: the unavailable book ids are surfaced in error details
    expect(errorMentions(error, short.id)).toBe(true);

    // nothing persisted — the healthy position stays fully available
    expect(repository.reservations.size).toBe(0);
    const after = await service.getBook({ bookId: ok.id });
    expect(after.book?.available).toBe(5);
  });

  it("rejects a deleted book with FAILED_PRECONDITION", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, {
      stock: 5,
      deletedAt: new Date()
    });
    await expectGrpcError(
      service.reserveStock({ items: [{ bookId: book.id, amount: 1 }] }, CALLER),
      status.FAILED_PRECONDITION
    );
  });
});

describe("CommitStock", () => {
  it("decrements stock and marks the reservation COMMITTED", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 5 });

    const res = await service.reserveStock(
      { items: [{ bookId: book.id, amount: 2 }] },
      CALLER
    );
    await service.commitStock({ reservationId: res.reservationId }, CALLER);

    const book2 = await service.getBook({ bookId: book.id });
    expect(book2.book?.stock).toBe(3);
    expect(book2.book?.available).toBe(3);
    expect(repository.reservations.get(res.reservationId)?.status).toBe(
      "COMMITTED"
    );
  });

  it("is idempotent: a second commit on COMMITTED succeeds without decrementing again", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 10 });

    const res = await service.reserveStock(
      { items: [{ bookId: book.id, amount: 2 }] },
      CALLER
    );
    await service.commitStock({ reservationId: res.reservationId }, CALLER);
    const once = await service.getBook({ bookId: book.id });
    expect(once.book?.stock).toBe(8);

    // retry of the same reservation_id (order-service resend) — success,
    // stock untouched
    await service.commitStock({ reservationId: res.reservationId }, CALLER);
    const twice = await service.getBook({ bookId: book.id });
    expect(twice.book?.stock).toBe(8);
  });

  it("returns FAILED_PRECONDITION and rolls back when stock dropped below the reserved amount", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 5 });
    const other = seedBook(repository, { stock: 5 });

    const res = await service.reserveStock(
      {
        items: [
          { bookId: book.id, amount: 2 },
          { bookId: other.id, amount: 1 }
        ]
      },
      CALLER
    );
    // stock moved out-of-band since ReserveStock — below the held amount
    repository.books.get(other.id)!.stock = 0;

    await expectGrpcError(
      service.commitStock({ reservationId: res.reservationId }, CALLER),
      status.FAILED_PRECONDITION
    );

    // all-or-nothing rollback: no position decremented, still ACTIVE
    expect(repository.books.get(book.id)?.stock).toBe(5);
    expect(repository.books.get(other.id)?.stock).toBe(0);
    expect(repository.reservations.get(res.reservationId)?.status).toBe(
      "ACTIVE"
    );
  });

  it("returns NOT_FOUND for an unknown reservation", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.commitStock({ reservationId: "missing" }, CALLER),
      status.NOT_FOUND
    );
  });

  it("returns NOT_FOUND for an expired reservation (lazy TTL)", async () => {
    let now = new Date("2030-06-01T12:00:00.000Z");
    const { service, repository } = harness({
      reservationTtlSec: 60,
      now: () => now
    });
    const book = seedBook(repository, { stock: 5 });

    const res = await service.reserveStock(
      { items: [{ bookId: book.id, amount: 2 }] },
      CALLER
    );
    now = new Date(now.getTime() + 61_000); // past expires_at

    await expectGrpcError(
      service.commitStock({ reservationId: res.reservationId }, CALLER),
      status.NOT_FOUND
    );
    // and stock was never decremented
    const book2 = await service.getBook({ bookId: book.id });
    expect(book2.book?.stock).toBe(5);
    // availability is free again for a fresh reservation
    const again = await service.reserveStock(
      { items: [{ bookId: book.id, amount: 5 }] },
      CALLER
    );
    expect(again.reservationId).toBeTruthy();
  });

  it("returns NOT_FOUND for a released reservation", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 5 });
    const res = await service.reserveStock(
      { items: [{ bookId: book.id, amount: 2 }] },
      CALLER
    );
    await service.releaseStock({ reservationId: res.reservationId }, CALLER);
    await expectGrpcError(
      service.commitStock({ reservationId: res.reservationId }, CALLER),
      status.NOT_FOUND
    );
  });
});

describe("ReleaseStock", () => {
  it("releases the reservation and restores availability", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 5 });

    const res = await service.reserveStock(
      { items: [{ bookId: book.id, amount: 3 }] },
      CALLER
    );
    await service.releaseStock({ reservationId: res.reservationId }, CALLER);

    expect(repository.reservations.get(res.reservationId)?.status).toBe(
      "RELEASED"
    );
    const book2 = await service.getBook({ bookId: book.id });
    expect(book2.book?.available).toBe(5);
  });

  it("returns NOT_FOUND for an unknown reservation", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.releaseStock({ reservationId: "missing" }, CALLER),
      status.NOT_FOUND
    );
  });

  it("returns NOT_FOUND for an expired reservation", async () => {
    let now = new Date("2030-06-01T12:00:00.000Z");
    const { service, repository } = harness({
      reservationTtlSec: 60,
      now: () => now
    });
    const book = seedBook(repository, { stock: 5 });

    const res = await service.reserveStock(
      { items: [{ bookId: book.id, amount: 1 }] },
      CALLER
    );
    now = new Date(now.getTime() + 61_000);

    await expectGrpcError(
      service.releaseStock({ reservationId: res.reservationId }, CALLER),
      status.NOT_FOUND
    );
  });

  it("rejects a COMMITTED reservation with FAILED_PRECONDITION", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 5 });
    const res = await service.reserveStock(
      { items: [{ bookId: book.id, amount: 2 }] },
      CALLER
    );
    await service.commitStock({ reservationId: res.reservationId }, CALLER);

    await expectGrpcError(
      service.releaseStock({ reservationId: res.reservationId }, CALLER),
      status.FAILED_PRECONDITION
    );
  });

  it("rejects an already-RELEASED reservation with FAILED_PRECONDITION", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 5 });
    const res = await service.reserveStock(
      { items: [{ bookId: book.id, amount: 2 }] },
      CALLER
    );
    await service.releaseStock({ reservationId: res.reservationId }, CALLER);

    await expectGrpcError(
      service.releaseStock({ reservationId: res.reservationId }, CALLER),
      status.FAILED_PRECONDITION
    );
  });
});
