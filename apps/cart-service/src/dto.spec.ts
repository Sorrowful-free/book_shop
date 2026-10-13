import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { status } from "@grpc/grpc-js";
import { RpcException } from "@nestjs/microservices";
import { requestValidationPipe } from "@book-shop/common";
import {
  AddItemDto,
  ClearCartDto,
  GetCartDto,
  MergeCartDto,
  RemoveItemDto,
  UpdateItemDto
} from "./dto";

const GUEST_ID = "3f6a1d2e-9b8c-4e5a-a7b6-c5d4e3f2a1b0";

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

describe("request DTO validation (F-K3 boundary)", () => {
  it("an absent cart_id is valid (user-cart mode)", async () => {
    const dto = await validate(GetCartDto, {});
    expect(dto.cartId).toBeUndefined();
  });

  it("a present-but-empty cart_id is INVALID_ARGUMENT, not user-cart mode", async () => {
    await expectInvalid(validate(GetCartDto, { cartId: "" }));
    await expectInvalid(
      validate(AddItemDto, { cartId: "", bookId: "b1", amount: 1 })
    );
    await expectInvalid(
      validate(UpdateItemDto, { cartId: "", bookId: "b1", amount: 1 })
    );
    await expectInvalid(validate(RemoveItemDto, { cartId: "", bookId: "b1" }));
    await expectInvalid(validate(ClearCartDto, { cartId: "" }));
  });

  it("a malformed cart_id is INVALID_ARGUMENT", async () => {
    await expectInvalid(validate(GetCartDto, { cartId: "not-a-uuid" }));
    await expectInvalid(validate(ClearCartDto, { cartId: "nope" }));
  });

  it("a valid cart_id passes — uppercase uuids included", async () => {
    const lower = await validate(GetCartDto, { cartId: GUEST_ID });
    expect(lower.cartId).toBe(GUEST_ID);
    const upper = await validate(GetCartDto, {
      cartId: GUEST_ID.toUpperCase()
    });
    expect(upper.cartId).toBe(GUEST_ID.toUpperCase());
  });

  it("book_id must be a non-empty string", async () => {
    await expectInvalid(
      validate(AddItemDto, { cartId: GUEST_ID, bookId: "", amount: 1 })
    );
    await expectInvalid(
      validate(RemoveItemDto, { cartId: GUEST_ID, bookId: "" })
    );
    await expectInvalid(
      validate(AddItemDto, { cartId: GUEST_ID, bookId: 5, amount: 1 })
    );
  });

  it("AddItem.amount must be an integer >= 1", async () => {
    await expectInvalid(
      validate(AddItemDto, { cartId: GUEST_ID, bookId: "b1", amount: 0 })
    );
    await expectInvalid(
      validate(AddItemDto, { cartId: GUEST_ID, bookId: "b1", amount: -3 })
    );
    await expectInvalid(
      validate(AddItemDto, { cartId: GUEST_ID, bookId: "b1", amount: 1.5 })
    );
    const dto = await validate(AddItemDto, {
      cartId: GUEST_ID,
      bookId: "b1",
      amount: 3
    });
    expect(dto.amount).toBe(3);
  });

  it("UpdateItem.amount must be an integer >= 0 (0 removes the position)", async () => {
    await expectInvalid(
      validate(UpdateItemDto, { cartId: GUEST_ID, bookId: "b1", amount: -1 })
    );
    await expectInvalid(
      validate(UpdateItemDto, {
        cartId: GUEST_ID,
        bookId: "b1",
        amount: 2.5
      })
    );
    const dto = await validate(UpdateItemDto, {
      cartId: GUEST_ID,
      bookId: "b1",
      amount: 0
    });
    expect(dto.amount).toBe(0);
  });

  it("MergeCart.guest_cart_id must be a uuid", async () => {
    await expectInvalid(validate(MergeCartDto, { guestCartId: "" }));
    await expectInvalid(validate(MergeCartDto, { guestCartId: "nope" }));
    await expectInvalid(validate(MergeCartDto, {}));
    const dto = await validate(MergeCartDto, {
      guestCartId: GUEST_ID.toUpperCase()
    });
    expect(dto.guestCartId).toBe(GUEST_ID.toUpperCase());
  });
});
