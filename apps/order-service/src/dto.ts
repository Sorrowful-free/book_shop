import { IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";
import type { orderProto } from "@book-shop/contracts";
import { MAX_LIMIT } from "./order.service";

/**
 * Boundary validation for the gRPC surface: the static shape of each
 * request — uuid ids/keys, pagination bounds — is checked by
 * class-validator DTOs via the shared `requestValidationPipe`
 * (@book-shop/common) before the domain service runs; a violation maps to
 * RpcException INVALID_ARGUMENT.
 *
 * proto3 implicit presence: `offset: 0` is never serialized on the wire and
 * arrives absent — it stays optional in the DTO with the service
 * normalizing it to 0.
 */

export class CheckoutDto implements orderProto.CheckoutRequest {
  /** Producer is the api-gateway (Idempotency-Key header or generated). */
  @IsUUID()
  idempotencyKey!: string;
}

export class GetOrderDto implements orderProto.GetOrderRequest {
  @IsUUID()
  orderId!: string;
}

export class ListMyOrdersDto implements orderProto.ListMyOrdersRequest {
  /** Absent means 0 — proto3 never serializes the default value. */
  @IsOptional()
  @IsInt()
  @Min(0)
  offset!: number;

  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit!: number;
}

export class PayOrderDto implements orderProto.PayOrderRequest {
  @IsUUID()
  orderId!: string;
}

export class CancelOrderDto implements orderProto.CancelOrderRequest {
  @IsUUID()
  orderId!: string;
}
