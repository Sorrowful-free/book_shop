import { describe, expect, it } from "bun:test";
import { status } from "@grpc/grpc-js";
import { UserRole } from "@book-shop/contracts";
import { caller, expectGrpcError, harness, seedBook } from "../test/helpers";

const CREATE_REQUEST = {
  bookName: "Guarded",
  author: "Spec",
  price: 10,
  stock: 1
};

describe("role guard — read RPCs are public", () => {
  it("List/Search/Get/GetBooksByIds need no caller at all", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository);

    await service.listBooks({ offset: 0, limit: 10 });
    await service.searchBooks({ offset: 0, limit: 10 });
    await service.getBook({ bookId: book.id });
    await service.getBooksByIds({ bookIds: [book.id] });
  });
});

describe("role guard — CreateBook / UpdateBook need EMPLOYER or ADMIN", () => {
  it.each([UserRole.Employer, UserRole.Admin])(
    "allows CreateBook for %s",
    async (role) => {
      const { service } = harness();
      const res = await service.createBook(CREATE_REQUEST, caller(role));
      expect(res.book?.bookId).toBeTruthy();
    }
  );

  it("rejects CreateBook for CUSTOMER with PERMISSION_DENIED", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.createBook(CREATE_REQUEST, caller(UserRole.Customer)),
      status.PERMISSION_DENIED
    );
  });

  it("rejects CreateBook without a JWT with UNAUTHENTICATED", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.createBook(CREATE_REQUEST, null),
      status.UNAUTHENTICATED
    );
  });

  it.each([UserRole.Employer, UserRole.Admin])(
    "allows UpdateBook for %s",
    async (role) => {
      const { service, repository } = harness();
      const book = seedBook(repository, { bookName: "Before" });
      const res = await service.updateBook(
        { bookId: book.id, bookName: "After" },
        caller(role)
      );
      expect(res.book?.bookName).toBe("After");
    }
  );

  it("rejects UpdateBook for CUSTOMER with PERMISSION_DENIED", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository);
    await expectGrpcError(
      service.updateBook(
        { bookId: book.id, bookName: "Nope" },
        caller(UserRole.Customer)
      ),
      status.PERMISSION_DENIED
    );
  });

  it("rejects UpdateBook without a JWT with UNAUTHENTICATED", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository);
    await expectGrpcError(
      service.updateBook({ bookId: book.id, bookName: "Nope" }, null),
      status.UNAUTHENTICATED
    );
  });
});

describe("role guard — DeleteBook / RestoreBook are ADMIN-only", () => {
  it("allows DeleteBook for ADMIN", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository);
    await service.deleteBook({ bookId: book.id }, caller(UserRole.Admin));
    const res = await service.getBook({ bookId: book.id });
    expect(res.book?.isDeleted).toBe(true);
  });

  it.each([UserRole.Employer, UserRole.Customer])(
    "rejects DeleteBook for %s with PERMISSION_DENIED",
    async (role) => {
      const { service, repository } = harness();
      const book = seedBook(repository);
      await expectGrpcError(
        service.deleteBook({ bookId: book.id }, caller(role)),
        status.PERMISSION_DENIED
      );
    }
  );

  it("rejects DeleteBook without a JWT with UNAUTHENTICATED", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository);
    await expectGrpcError(
      service.deleteBook({ bookId: book.id }, null),
      status.UNAUTHENTICATED
    );
  });

  it("allows RestoreBook for ADMIN", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { deletedAt: new Date() });
    const res = await service.restoreBook(
      { bookId: book.id },
      caller(UserRole.Admin)
    );
    expect(res.book?.isDeleted).toBe(false);
  });

  it.each([UserRole.Employer, UserRole.Customer])(
    "rejects RestoreBook for %s with PERMISSION_DENIED",
    async (role) => {
      const { service, repository } = harness();
      const book = seedBook(repository, { deletedAt: new Date() });
      await expectGrpcError(
        service.restoreBook({ bookId: book.id }, caller(role)),
        status.PERMISSION_DENIED
      );
    }
  );

  it("rejects RestoreBook without a JWT with UNAUTHENTICATED", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { deletedAt: new Date() });
    await expectGrpcError(
      service.restoreBook({ bookId: book.id }, null),
      status.UNAUTHENTICATED
    );
  });
});

describe("role guard — Reserve/Commit/Release accept any valid JWT", () => {
  it.each([UserRole.Customer, UserRole.Employer, UserRole.Admin])(
    "allows the reserve→release lifecycle for %s",
    async (role) => {
      const { service, repository } = harness();
      const book = seedBook(repository, { stock: 2 });
      const user = caller(role);

      const res = await service.reserveStock(
        { items: [{ bookId: book.id, amount: 1 }] },
        user
      );
      await service.releaseStock({ reservationId: res.reservationId }, user);
    }
  );

  it("allows commit for any authenticated role", async () => {
    const { service, repository } = harness();
    const book = seedBook(repository, { stock: 2 });
    const res = await service.reserveStock(
      { items: [{ bookId: book.id, amount: 1 }] },
      caller(UserRole.Customer)
    );
    await service.commitStock(
      { reservationId: res.reservationId },
      caller(UserRole.Customer)
    );
    const book2 = await service.getBook({ bookId: book.id });
    expect(book2.book?.stock).toBe(1);
  });

  it.each(["reserveStock", "commitStock", "releaseStock"] as const)(
    "rejects %s without a JWT with UNAUTHENTICATED",
    async (method) => {
      const { service, repository } = harness();
      const book = seedBook(repository, { stock: 2 });
      const request =
        method === "reserveStock"
          ? { items: [{ bookId: book.id, amount: 1 }] }
          : { reservationId: "some-id" };
      await expectGrpcError(
        (service[method] as (req: unknown, c: null) => Promise<unknown>)(
          request,
          null
        ),
        status.UNAUTHENTICATED
      );
    }
  );
});
