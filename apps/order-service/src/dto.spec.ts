import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { status } from "@grpc/grpc-js";
import { RpcException } from "@nestjs/microservices";
import { requestValidationPipe } from "@book-shop/common";
import {
  CancelOrderDto,
  CheckoutDto,
  GetOrderDto,
  ListMyOrdersDto,
  PayOrderDto
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

const UUID = "3f8b2a1e-5c6d-4e7f-9a0b-1c2d3e4f5a6b";

describe("CheckoutDto", () => {
  it("accepts a uuid idempotency_key", async () => {
    const dto = await validate(CheckoutDto, { idempotencyKey: UUID });
    expect(dto.idempotencyKey).toBe(UUID);
  });

  it.each(["", "not-a-uuid", 42, undefined])(
    "rejects idempotencyKey=%j",
    async (idempotencyKey) => {
      await expectInvalid(validate(CheckoutDto, { idempotencyKey }));
    }
  );
});

describe("order id DTOs", () => {
  it.each(["x", "", undefined])("rejects orderId=%j", async (orderId) => {
    await expectInvalid(validate(GetOrderDto, { orderId }));
    await expectInvalid(validate(PayOrderDto, { orderId }));
    await expectInvalid(validate(CancelOrderDto, { orderId }));
  });

  it("accepts a uuid order_id", async () => {
    for (const metatype of [GetOrderDto, PayOrderDto, CancelOrderDto]) {
      const dto = await validate(metatype, { orderId: UUID });
      expect(dto.orderId).toBe(UUID);
    }
  });
});

describe("ListMyOrdersDto", () => {
  it("accepts a valid page and an absent offset", async () => {
    const dto = await validate(ListMyOrdersDto, { limit: 10 });
    expect(dto.offset).toBeUndefined();
    expect(
      (await validate(ListMyOrdersDto, { offset: 0, limit: 10 })).limit
    ).toBe(10);
  });

  it.each([
    { offset: -1, limit: 10 },
    { offset: 0.5, limit: 10 }
  ])("rejects a bad offset %j", async (payload) => {
    await expectInvalid(validate(ListMyOrdersDto, payload));
  });

  it.each([0, 101, -5, 1.5, undefined])(
    "rejects limit=%j outside 1..100",
    async (limit) => {
      await expectInvalid(validate(ListMyOrdersDto, { offset: 0, limit }));
    }
  );
});
