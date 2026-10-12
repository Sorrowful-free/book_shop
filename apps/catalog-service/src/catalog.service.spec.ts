import { describe, expect, it } from "bun:test";
import { status } from "@grpc/grpc-js";
import { EVENT_TYPES, UserRole } from "@book-shop/contracts";
import {
  caller,
  expectGrpcError,
  harness,
  seedBook,
  seedReservation
} from "../test/helpers";

const ADMIN = caller(UserRole.Admin);

describe("ListBooks — pagination & validation", () => {
  it.each([0, -1, 101, 1000])(
    "rejects limit=%i with INVALID_ARGUMENT",
    async (limit) => {
      const { service } = harness();
      await expectGrpcError(
        service.listBooks({ offset: 0, limit }),
        status.INVALID_ARGUMENT
      );
    }
  );

  it("accepts the boundary limits 1 and 100", async () => {
    const { service } = harness();
    await service.listBooks({ offset: 0, limit: 1 });
    await service.listBooks({ offset: 0, limit: 100 });
  });

  it("rejects a negative offset with INVALID_ARGUMENT", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.listBooks({ offset: -1, limit: 10 }),
      status.INVALID_ARGUMENT
    );
    await expectGrpcError(
      service.searchBooks({ offset: -1, limit: 10 }),
      status.INVALID_ARGUMENT
    );
  });

  it("paginates by offset/limit and returns total", async () => {
    const { service, repository } = harness();
    for (let i = 0; i < 5; i++) {
      seedBook(repository, { bookName: `Paginated ${i}` });
    }

    const page1 = await service.listBooks({ offset: 0, limit: 2 });
    const page2 = await service.listBooks({ offset: 2, limit: 2 });
    const page3 = await service.listBooks({ offset: 4, limit: 2 });

    expect(page1.total).toBe(5);
    expect(page2.total).toBe(5);
    expect(page3.total).toBe(5);
    expect(page1.books).toHaveLength(2);
    expect(page2.books).toHaveLength(2);
    expect(page3.books).toHaveLength(1);

    const paged = [...page1.books, ...page2.books, ...page3.books].map(
      (b) => b.bookId
    );
    expect(new Set(paged).size).toBe(5); // stable ordering, no overlap
  });
});

describe("SearchBooks — substring query + exact genre", () => {
  it("matches query on book_name or author, case-insensitive", async () => {
    const { service, repository } = harness();
    const hobbit = seedBook(repository, {
      bookName: "The Hobbit",
      author: "J. R. R. Tolkien"
    });
    seedBook(repository, {
      bookName: "Clean Code",
      author: "Robert C. Martin"
    });
    const tales = seedBook(repository, {
      bookName: "hobbit tales",
      author: "Someone Else"
    });

    const byName = await service.searchBooks({
      query: "HOBBIT",
      offset: 0,
      limit: 10
    });
    expect(byName.total).toBe(2);
    expect(byName.books.map((b) => b.bookId).sort()).toEqual(
      [hobbit.id, tales.id].sort()
    );

    const byAuthor = await service.searchBooks({
      query: "tolkien",
      offset: 0,
      limit: 10
    });
    expect(byAuthor.total).toBe(1);
    expect(byAuthor.books[0].bookId).toBe(hobbit.id);
  });

  it("filters genre exactly", async () => {
    const { service, repository } = harness();
    const fantasy = seedBook(repository, { genre: "fantasy" });
    seedBook(repository, { genre: "Fantasy" }); // exact filter — no match
    seedBook(repository, { genre: "sci-fi" });

    const res = await service.searchBooks({
      genre: "fantasy",
      offset: 0,
      limit: 10
    });
    expect(res.total).toBe(1);
    expect(res.books[0].bookId).toBe(fantasy.id);
  });

  it("combines query and genre", async () => {
    const { service, repository } = harness();
    const wanted = seedBook(repository, {
      bookName: "Dune",
      genre: "sci-fi"
    });
    seedBook(repository, { bookName: "Dune Messiah", genre: "fantasy" });

    const res = await service.searchBooks({
      query: "dune",
      genre: "sci-fi",
      offset: 0,
      limit: 10
    });
    expect(res.books.map((b) => b.bookId)).toEqual([wanted.id]);
  });

  it("returns all books when no filter is given", async () => {
    const { service, repository } = harness();
    seedBook(repository);
    seedBook(repository);
    const res = await service.searchBooks({ offset: 0, limit: 10 });
    expect(res.total).toBe(2);
  });

  it("treats an empty genre string as absent (like an empty query)", async () => {
    const { service, repository } = harness();
    seedBook(repository, { genre: "fantasy" });
    seedBook(repository, { genre: "sci-fi" });

    const res = await service.searchBooks({
      genre: "",
      offset: 0,
      limit: 10
    });
    expect(res.total).toBe(2);
  });
});

describe("GetBook / GetBooksByIds", () => {
  it("returns a mapped proto Book by id", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, {
      bookName: "Dune",
      author: "Frank Herbert",
      isbn: "978-0-441-17271-9",
      price: 12.5,
      stock: 4,
      genre: "sci-fi",
      year: 1965
    });

    const res = await service.getBook({ bookId: book.id });
    expect(res.book?.bookId).toBe(book.id);
    expect(res.book?.bookName).toBe("Dune");
    expect(res.book?.author).toBe("Frank Herbert");
    expect(res.book?.isbn).toBe("978-0-441-17271-9");
    expect(res.book?.price).toBe(12.5);
    expect(res.book?.stock).toBe(4);
    expect(res.book?.available).toBe(4);
    expect(res.book?.isDeleted).toBe(false);
  });

  it("returns NOT_FOUND for a missing id", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.getBook({ bookId: "missing" }),
      status.NOT_FOUND
    );
  });

  it("returns all found books — deleted books included with is_deleted + available=0", async () => {
    const { service, repository } = harness();
    const alive = seedBook(repository, { stock: 3 });
    const deleted = seedBook(repository, {
      stock: 3,
      deletedAt: new Date()
    });

    const res = await service.getBooksByIds({
      bookIds: [alive.id, deleted.id]
    });
    expect(res.books).toHaveLength(2);
    const byId = new Map(res.books.map((b) => [b.bookId, b]));
    expect(byId.get(alive.id)?.isDeleted).toBe(false);
    expect(byId.get(alive.id)?.available).toBe(3);
    expect(byId.get(deleted.id)?.isDeleted).toBe(true);
    expect(byId.get(deleted.id)?.available).toBe(0);
  });

  it("fails the whole request with NOT_FOUND when any single id is missing", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository);
    await expectGrpcError(
      service.getBooksByIds({ bookIds: [book.id, "missing-id"] }),
      status.NOT_FOUND
    );
  });
});

describe("availability = stock − active non-expired reservations", () => {
  it("subtracts live ACTIVE reservations from stock", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 10 });
    seedReservation(repository, {
      items: [{ bookId: book.id, amount: 3 }]
    });
    seedReservation(repository, {
      items: [{ bookId: book.id, amount: 2 }]
    });

    const res = await service.getBook({ bookId: book.id });
    expect(res.book?.stock).toBe(10);
    expect(res.book?.available).toBe(5);
  });

  it("ignores expired ACTIVE reservations", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 10 });
    seedReservation(repository, {
      items: [{ bookId: book.id, amount: 4 }],
      expiresAt: new Date(Date.now() - 1_000) // already expired
    });

    const res = await service.getBook({ bookId: book.id });
    expect(res.book?.available).toBe(10);
  });

  it("ignores COMMITTED/RELEASED/EXPIRED reservations", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 10 });
    // COMMITTED reservations already decremented stock — seed accordingly
    seedReservation(repository, {
      status: "COMMITTED",
      items: [{ bookId: book.id, amount: 2 }]
    });
    seedReservation(repository, {
      status: "RELEASED",
      items: [{ bookId: book.id, amount: 2 }]
    });
    seedReservation(repository, {
      status: "EXPIRED",
      items: [{ bookId: book.id, amount: 2 }]
    });

    const res = await service.getBook({ bookId: book.id });
    expect(res.book?.available).toBe(10);
  });

  it("reports available=0 for a deleted book regardless of stock", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, {
      stock: 10,
      deletedAt: new Date()
    });

    const res = await service.getBook({ bookId: book.id });
    expect(res.book?.available).toBe(0);
    expect(res.book?.isDeleted).toBe(true);
  });
});

describe("CreateBook", () => {
  it("creates a book and returns it with available=stock", async () => {
    const { service } = harness();

    const res = await service.createBook(
      {
        bookName: "Dune",
        author: "Frank Herbert",
        isbn: "978-0-441-17271-9",
        description: "Arrakis",
        genre: "sci-fi",
        year: 1965,
        coverUrl: "https://example.test/dune.jpg",
        price: 12.5,
        stock: 4
      },
      ADMIN
    );

    expect(res.book?.bookId).toBeTruthy();
    expect(res.book?.bookName).toBe("Dune");
    expect(res.book?.price).toBe(12.5);
    expect(res.book?.stock).toBe(4);
    expect(res.book?.available).toBe(4);
    expect(res.book?.isDeleted).toBe(false);
  });

  it("writes catalog.book.created to the outbox within the same mutation", async () => {
    const { service, repository } = harness();

    const res = await service.createBook(
      { bookName: "Dune", author: "Frank Herbert", price: 12.5, stock: 4 },
      ADMIN
    );

    expect(repository.outbox).toHaveLength(1);
    expect(repository.outbox[0].eventType).toBe(EVENT_TYPES.bookCreated);
    expect(repository.outbox[0].payload).toMatchObject({
      bookId: res.book!.bookId,
      bookName: "Dune",
      author: "Frank Herbert",
      price: 12.5
    });
  });

  it("rejects a duplicate isbn with ALREADY_EXISTS and writes no outbox", async () => {
    const { service, repository } = harness();
    const request = {
      bookName: "Dune",
      author: "Frank Herbert",
      isbn: "978-0-441-17271-9",
      price: 12.5,
      stock: 4
    };
    await service.createBook(request, ADMIN);

    await expectGrpcError(
      service.createBook(request, ADMIN),
      status.ALREADY_EXISTS
    );
    expect(repository.outbox).toHaveLength(1); // only the first create
  });

  it("creates a book without isbn (isbn stays unset)", async () => {
    const { service } = harness();
    const res = await service.createBook(
      { bookName: "No ISBN", author: "Anon", price: 1, stock: 1 },
      ADMIN
    );
    expect(res.book?.bookId).toBeTruthy();
  });

  it.each([
    [{ price: -0.01 }, "negative price"],
    [{ stock: -1 }, "negative stock"],
    [{ bookName: "" }, "empty book_name"],
    [{ author: "" }, "empty author"],
    [{ year: -1 }, "negative year"],
    [{ year: new Date().getFullYear() + 5 }, "absurd future year"]
  ])("rejects %j with INVALID_ARGUMENT (%s)", async (patch) => {
    const { service } = harness();
    await expectGrpcError(
      service.createBook(
        {
          bookName: "Dune",
          author: "Frank Herbert",
          price: 10,
          stock: 1,
          ...patch
        },
        ADMIN
      ),
      status.INVALID_ARGUMENT
    );
  });
});

describe("UpdateBook", () => {
  it("patches fields and writes catalog.book.updated", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, {
      bookName: "Old Name",
      price: 10,
      stock: 1
    });

    const res = await service.updateBook(
      { bookId: book.id, bookName: "New Name", price: 19.99, stock: 9 },
      ADMIN
    );
    expect(res.book?.bookName).toBe("New Name");
    expect(res.book?.price).toBe(19.99);
    expect(res.book?.stock).toBe(9);

    const updated = repository.outbox.find(
      (e) => e.eventType === EVENT_TYPES.bookUpdated
    );
    expect(updated).toBeDefined();
    expect(updated?.payload).toMatchObject({ bookId: book.id, price: 19.99 });
  });

  it("leaves untouched fields unchanged", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { bookName: "Keep Me", price: 7 });

    const res = await service.updateBook({ bookId: book.id, price: 8 }, ADMIN);
    expect(res.book?.bookName).toBe("Keep Me");
    expect(res.book?.price).toBe(8);
  });

  it("returns NOT_FOUND for a missing book", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.updateBook({ bookId: "missing", price: 5 }, ADMIN),
      status.NOT_FOUND
    );
  });

  it("rejects an invalid patch with INVALID_ARGUMENT", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository);
    await expectGrpcError(
      service.updateBook({ bookId: book.id, price: -1 }, ADMIN),
      status.INVALID_ARGUMENT
    );
    await expectGrpcError(
      service.updateBook({ bookId: book.id, stock: -5 }, ADMIN),
      status.INVALID_ARGUMENT
    );
  });

  it("rejects lowering stock below active reservations with FAILED_PRECONDITION", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 5 });
    seedReservation(repository, {
      items: [{ bookId: book.id, amount: 3 }]
    });

    await expectGrpcError(
      service.updateBook({ bookId: book.id, stock: 2 }, ADMIN),
      status.FAILED_PRECONDITION
    );
    // rejected patch was not applied
    expect(repository.books.get(book.id)?.stock).toBe(5);
    // lowering to exactly the reserved amount is allowed
    const res = await service.updateBook({ bookId: book.id, stock: 3 }, ADMIN);
    expect(res.book?.stock).toBe(3);
  });

  it("ignores expired reservations when validating a stock patch", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 5 });
    seedReservation(repository, {
      items: [{ bookId: book.id, amount: 4 }],
      expiresAt: new Date(Date.now() - 1_000) // already expired
    });

    const res = await service.updateBook({ bookId: book.id, stock: 1 }, ADMIN);
    expect(res.book?.stock).toBe(1);
  });
});

describe("DeleteBook / RestoreBook (soft delete)", () => {
  it("soft-deletes: visible in reads, is_deleted=true, writes book.deleted", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 4 });

    await service.deleteBook({ bookId: book.id }, ADMIN);

    const res = await service.getBook({ bookId: book.id });
    expect(res.book?.isDeleted).toBe(true);
    expect(res.book?.available).toBe(0);

    const deleted = repository.outbox.find(
      (e) => e.eventType === EVENT_TYPES.bookDeleted
    );
    expect(deleted).toBeDefined();
    expect(deleted?.payload).toMatchObject({ bookId: book.id });
  });

  it("returns NOT_FOUND for a missing book", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.deleteBook({ bookId: "missing" }, ADMIN),
      status.NOT_FOUND
    );
  });

  it("restores a deleted book (is_deleted=false, available back)", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 4, deletedAt: new Date() });

    const res = await service.restoreBook({ bookId: book.id }, ADMIN);
    expect(res.book?.isDeleted).toBe(false);
    expect(res.book?.available).toBe(4);
  });

  it("rejects restore of a non-deleted book with FAILED_PRECONDITION", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository);
    await expectGrpcError(
      service.restoreBook({ bookId: book.id }, ADMIN),
      status.FAILED_PRECONDITION
    );
  });

  it("returns NOT_FOUND when restoring a missing book", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.restoreBook({ bookId: "missing" }, ADMIN),
      status.NOT_FOUND
    );
  });

  it("writes no outbox event on restore", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { deletedAt: new Date() });
    await service.restoreBook({ bookId: book.id }, ADMIN);
    expect(repository.outbox).toHaveLength(0);
  });
});

describe("column-boundary overflow guards (F-C2)", () => {
  it.each([1e15, 100_000_000])(
    "rejects createBook price=%j above the Decimal(10,2) bound",
    async (price) => {
      const { service, repository } = harness();
      await expectGrpcError(
        service.createBook(
          { bookName: "Dune", author: "Frank Herbert", price, stock: 1 },
          ADMIN
        ),
        status.INVALID_ARGUMENT
      );
      // rejected before the repository — nothing persisted
      expect(repository.books.size).toBe(0);
    }
  );

  it("accepts the exact Decimal(10,2) boundary price 99999999.99", async () => {
    const { service } = harness();
    const res = await service.createBook(
      { bookName: "Edge", author: "A", price: 99_999_999.99, stock: 1 },
      ADMIN
    );
    expect(res.book?.price).toBe(99_999_999.99);
  });

  it("rejects updateBook price=1e15 with INVALID_ARGUMENT, book untouched", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { price: 10 });
    await expectGrpcError(
      service.updateBook({ bookId: book.id, price: 1e15 }, ADMIN),
      status.INVALID_ARGUMENT
    );
    expect(repository.books.get(book.id)?.price).toBe(10);
  });

  it.each([2_147_483_648, 1e10])(
    "rejects createBook stock=%j above the int4 bound",
    async (stock) => {
      const { service, repository } = harness();
      await expectGrpcError(
        service.createBook(
          { bookName: "Dune", author: "Frank Herbert", price: 1, stock },
          ADMIN
        ),
        status.INVALID_ARGUMENT
      );
      expect(repository.books.size).toBe(0);
    }
  );

  it("accepts stock exactly at int32 max", async () => {
    const { service } = harness();
    const res = await service.createBook(
      { bookName: "Dune", author: "A", price: 1, stock: 2_147_483_647 },
      ADMIN
    );
    expect(res.book?.stock).toBe(2_147_483_647);
  });

  it("rejects updateBook stock above int32 max", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 5 });
    await expectGrpcError(
      service.updateBook({ bookId: book.id, stock: 2_147_483_648 }, ADMIN),
      status.INVALID_ARGUMENT
    );
    expect(repository.books.get(book.id)?.stock).toBe(5);
  });

  it("rejects duplicate book_ids whose summed amount overflows int32", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 10 });
    await expectGrpcError(
      service.reserveStock(
        {
          items: [
            { bookId: book.id, amount: 2_147_483_647 },
            { bookId: book.id, amount: 1 }
          ]
        },
        caller(UserRole.Customer)
      ),
      status.INVALID_ARGUMENT
    );
    // rejected before the repository — no reservation row exists
    expect(repository.reservations.size).toBe(0);
  });

  it("accepts a single position at int32 max (shape ok, fails on stock)", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 10 });
    // amount itself is a valid int32 — the rejection is FAILED_PRECONDITION
    // (insufficient stock), not INVALID_ARGUMENT
    await expectGrpcError(
      service.reserveStock(
        { items: [{ bookId: book.id, amount: 2_147_483_647 }] },
        caller(UserRole.Customer)
      ),
      status.FAILED_PRECONDITION
    );
  });
});

describe("proto3 implicit presence — absent means default (F-C3)", () => {
  it("treats an absent offset as the proto3 default 0", async () => {
    const { service, repository } = harness();
    seedBook(repository);
    // `offset: 0` is never serialized on the wire — it arrives absent.
    const res = await service.listBooks({
      offset: undefined as unknown as number,
      limit: 10
    });
    expect(res.total).toBe(1);
    const found = await service.searchBooks({
      offset: undefined as unknown as number,
      limit: 10
    });
    expect(found.total).toBe(1);
  });
});
