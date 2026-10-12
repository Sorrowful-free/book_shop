import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { status } from "@grpc/grpc-js";
import { RpcException } from "@nestjs/microservices";
import {
  CommitStockDto,
  CreateBookDto,
  DeleteBookDto,
  GetBookDto,
  GetBooksByIdsDto,
  ListBooksDto,
  ReleaseStockDto,
  requestValidationPipe,
  ReserveStockDto,
  RestoreBookDto,
  SearchBooksDto,
  StockReservationItemDto,
  UpdateBookDto
} from "./dto";

/**
 * The same ValidationPipe the gRPC controller binds via @Payload() — driven
 * here directly so the boundary rules are covered without booting Nest.
 * `metatype` is what `design:paramtypes` emits for the decorated parameter.
 */
function validate<T>(metatype: new () => T, payload: unknown): Promise<T> {
  return requestValidationPipe.transform(payload, {
    metatype,
    type: "body"
  }) as Promise<T>;
}

async function expectInvalid(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    // Top-level `code` — the same contract as the rpcError() helper.
    expect((error as { code?: number }).code).toBe(status.INVALID_ARGUMENT);
    return;
  }
  expect.unreachable("expected INVALID_ARGUMENT");
}

describe("pagination DTOs (ListBooks / SearchBooks)", () => {
  it("accepts a valid page and returns a DTO instance", async () => {
    const dto = await validate(ListBooksDto, { offset: 0, limit: 10 });
    expect(dto).toBeInstanceOf(ListBooksDto);
    expect(dto.limit).toBe(10);
  });

  it("accepts an absent offset — never serialized on the wire", async () => {
    const dto = await validate(ListBooksDto, { limit: 10 });
    expect(dto.offset).toBeUndefined();
  });

  it.each([
    { offset: -1, limit: 10 },
    { offset: 0.5, limit: 10 }
  ])("rejects a bad offset %j with INVALID_ARGUMENT", async (payload) => {
    await expectInvalid(validate(ListBooksDto, payload));
    await expectInvalid(validate(SearchBooksDto, payload));
  });

  it.each([101, 0, -5, 1.5])(
    "rejects limit=%j outside 1..100",
    async (limit) => {
      await expectInvalid(validate(ListBooksDto, { offset: 0, limit }));
      await expectInvalid(validate(SearchBooksDto, { offset: 0, limit }));
    }
  );

  it("SearchBooks query/genre are optional and may be empty", async () => {
    await validate(SearchBooksDto, { offset: 0, limit: 10 });
    const dto = await validate(SearchBooksDto, {
      query: "",
      genre: "",
      offset: 0,
      limit: 10
    });
    expect(dto.query).toBe("");
    expect(dto.genre).toBe("");
  });
});

describe("single-id DTOs (GetBook / DeleteBook / RestoreBook)", () => {
  const idDtos = [GetBookDto, DeleteBookDto, RestoreBookDto] as const;

  it("requires a non-empty book_id", async () => {
    for (const metatype of idDtos) {
      await expectInvalid(validate(metatype, {}));
      await expectInvalid(validate(metatype, { bookId: "" }));
      await expectInvalid(validate(metatype, { bookId: 5 }));
      const dto = await validate(metatype, { bookId: "b-1" });
      expect(dto.bookId).toBe("b-1");
    }
  });
});

describe("GetBooksByIdsDto", () => {
  it("requires a list of non-empty strings", async () => {
    await expectInvalid(validate(GetBooksByIdsDto, {}));
    await expectInvalid(validate(GetBooksByIdsDto, { bookIds: "x" }));
    await expectInvalid(validate(GetBooksByIdsDto, { bookIds: ["a", ""] }));
    const dto = await validate(GetBooksByIdsDto, { bookIds: ["a", "b"] });
    expect(dto.bookIds).toEqual(["a", "b"]);
  });
});

describe("reservation DTOs (CommitStock / ReleaseStock)", () => {
  it("requires a non-empty reservation_id", async () => {
    for (const metatype of [CommitStockDto, ReleaseStockDto] as const) {
      await expectInvalid(validate(metatype, {}));
      await expectInvalid(validate(metatype, { reservationId: "" }));
      const dto = await validate(metatype, { reservationId: "r-1" });
      expect(dto.reservationId).toBe("r-1");
    }
  });
});

describe("CreateBookDto", () => {
  const valid = {
    bookName: "Dune",
    author: "Frank Herbert",
    price: 12.5,
    stock: 4
  };

  it("accepts a full request", async () => {
    const dto = await validate(CreateBookDto, {
      ...valid,
      isbn: "978-0-441-17271-9",
      description: "Arrakis",
      genre: "sci-fi",
      year: 1965,
      coverUrl: "https://example.test/dune.jpg"
    });
    expect(dto).toBeInstanceOf(CreateBookDto);
    expect(dto.bookName).toBe("Dune");
  });

  it("rejects a request missing required fields", async () => {
    await expectInvalid(validate(CreateBookDto, {}));
    await expectInvalid(
      validate(CreateBookDto, { bookName: "Dune", author: "Frank Herbert" })
    );
  });

  it.each([
    { bookName: "" },
    { author: "" },
    { price: -1 },
    { price: "free" },
    { stock: -1 },
    { stock: 1.5 },
    { year: -1 },
    { year: 2.5 }
  ])("rejects %j", async (patch) => {
    await expectInvalid(validate(CreateBookDto, { ...valid, ...patch }));
  });

  it("leaves column bounds and dynamic rules to the service", async () => {
    // Decimal(10,2) overflow, int4 overflow and the dynamic year cap are
    // domain/DB concerns — the boundary only checks the static shape.
    const dto = await validate(CreateBookDto, {
      ...valid,
      price: 1e15,
      stock: 2_147_483_648,
      year: 2999
    });
    expect(dto.price).toBe(1e15);
    expect(dto.stock).toBe(2_147_483_648);
    expect(dto.year).toBe(2999);
  });
});

describe("UpdateBookDto", () => {
  it("accepts book_id alone — a no-op patch stays a no-op", async () => {
    const dto = await validate(UpdateBookDto, { bookId: "b-1" });
    expect(dto.bookId).toBe("b-1");
  });

  it("accepts empty optional strings and zero values (clears)", async () => {
    const dto = await validate(UpdateBookDto, {
      bookId: "b-1",
      isbn: "",
      description: "",
      price: 0,
      stock: 0
    });
    expect(dto.isbn).toBe("");
    expect(dto.price).toBe(0);
    expect(dto.stock).toBe(0);
  });

  it.each([
    { bookId: "" },
    { bookName: "" },
    { author: "" },
    { price: -1 },
    { stock: -1.5 },
    { year: -1 }
  ])("rejects %j", async (payload) => {
    await expectInvalid(validate(UpdateBookDto, { bookId: "b-1", ...payload }));
  });
});

describe("ReserveStockDto", () => {
  it("rejects missing/empty items and malformed positions", async () => {
    await expectInvalid(validate(ReserveStockDto, {}));
    await expectInvalid(validate(ReserveStockDto, { items: [] }));
    await expectInvalid(
      validate(ReserveStockDto, { items: [{ bookId: "b", amount: 0 }] })
    );
    await expectInvalid(
      validate(ReserveStockDto, { items: [{ bookId: "b", amount: -3 }] })
    );
    await expectInvalid(
      validate(ReserveStockDto, { items: [{ bookId: "b", amount: 1.5 }] })
    );
    await expectInvalid(
      validate(ReserveStockDto, { items: [{ bookId: "", amount: 1 }] })
    );
    await expectInvalid(validate(ReserveStockDto, { items: [{}] }));
  });

  it("validates nested items into the item DTO type", async () => {
    const dto = await validate(ReserveStockDto, {
      items: [
        { bookId: "b-1", amount: 1 },
        { bookId: "b-2", amount: 3 }
      ]
    });
    expect(dto.items).toHaveLength(2);
    expect(dto.items[0]).toBeInstanceOf(StockReservationItemDto);
  });

  it("accepts duplicate book_ids (sum guard stays in service)", async () => {
    const dto = await validate(ReserveStockDto, {
      items: [
        { bookId: "b", amount: 2_147_483_647 },
        { bookId: "b", amount: 1 }
      ]
    });
    expect(dto.items).toHaveLength(2);
  });
});
