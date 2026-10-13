import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { status } from "@grpc/grpc-js";
import { RpcException } from "@nestjs/microservices";
import { Type } from "class-transformer";
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested
} from "class-validator";
import { requestValidationPipe } from "./rpc-validation-pipe";

class ItemDto {
  @IsString()
  @IsNotEmpty()
  sku!: string;

  @IsInt()
  @Min(1)
  amount!: number;
}

class OrderDto {
  @IsString()
  @IsNotEmpty()
  orderId!: string;

  @ValidateNested({ each: true })
  @Type(() => ItemDto)
  items!: ItemDto[];
}

/**
 * The same ValidationPipe gRPC controllers bind via @Payload() — driven here
 * directly so the exception contract is covered without booting Nest.
 * `metatype` is what `design:paramtypes` emits for the decorated parameter.
 */
function validate<T>(metatype: new () => T, payload: unknown): Promise<T> {
  return requestValidationPipe.transform(payload, {
    metatype,
    type: "body"
  }) as Promise<T>;
}

async function expectInvalid(promise: Promise<unknown>): Promise<RpcException> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    // Top-level `code` — grpc-js reads error.code when the exception
    // escapes raw (the same contract as the rpcError() helper).
    expect((error as { code?: number }).code).toBe(status.INVALID_ARGUMENT);
    const payload = (error as RpcException).getError() as {
      code?: number;
      message?: string;
    };
    expect(payload.code).toBe(status.INVALID_ARGUMENT);
    return error as RpcException;
  }
  return expect.unreachable("expected INVALID_ARGUMENT");
}

describe("requestValidationPipe", () => {
  it("transforms a valid payload into the metatype (nested items too)", async () => {
    const dto = await validate(OrderDto, {
      orderId: "o-1",
      items: [{ sku: "b-1", amount: 2 }]
    });
    expect(dto).toBeInstanceOf(OrderDto);
    expect(dto.items[0]).toBeInstanceOf(ItemDto);
    expect(dto.items[0]?.amount).toBe(2);
  });

  it("rejects a flat violation with INVALID_ARGUMENT and the constraint message", async () => {
    const error = await expectInvalid(
      validate(OrderDto, { orderId: "", items: [] })
    );
    const { message } = error.getError() as { message?: string };
    expect(message).toContain("orderId should not be empty");
  });

  it("flattens @ValidateNested children into the message", async () => {
    const error = await expectInvalid(
      validate(OrderDto, { orderId: "o-1", items: [{ sku: "", amount: 0 }] })
    );
    const { message } = error.getError() as { message?: string };
    expect(message).toContain("sku should not be empty");
    expect(message).toContain("amount must not be less than 1");
  });

  it("joins multiple violations with '; '", async () => {
    const error = await expectInvalid(
      validate(OrderDto, { orderId: "", items: [{ sku: "", amount: 0 }] })
    );
    const { message } = error.getError() as { message?: string };
    expect(message).toContain("; ");
  });
});
