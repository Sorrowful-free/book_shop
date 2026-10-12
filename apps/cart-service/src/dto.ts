import { ValidationPipe } from "@nestjs/common";
import { status } from "@grpc/grpc-js";
import { RpcException } from "@nestjs/microservices";
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  type ValidationError
} from "class-validator";
import type { cartProto } from "@book-shop/contracts";

/**
 * Boundary validation for the gRPC surface (docs/specs/fixes/cart-service.md
 * F-K3): the static shape of each request — uuid format, non-empty strings,
 * integer bounds — is checked by class-validator DTOs before the domain
 * service (and thus the repository) is reached. A violation maps to
 * RpcException INVALID_ARGUMENT; the top-level `code` mirrors the rpcError
 * pattern in cart.service so grpc-js reads the wire status even when the
 * exception bypasses the RpcException serializer.
 *
 * cart_id semantics (fixed by review): presence (`!== undefined`) selects
 * guest mode — NOT truthiness. `@IsOptional()` skips validation only when
 * the field is absent; a present `cart_id: ""` fails `@IsUUID()` →
 * INVALID_ARGUMENT instead of silently taking the user-cart path. uuid
 * matching is case-insensitive; lowercase normalization stays in the
 * service (Redis keys are case-sensitive).
 */
export const requestValidationPipe = new ValidationPipe({
  transform: true,
  exceptionFactory: (errors: ValidationError[]) => {
    const message =
      errors
        .flatMap((error) => Object.values(error.constraints ?? {}))
        .join("; ") || "invalid request";
    return Object.assign(
      new RpcException({ code: status.INVALID_ARGUMENT, message }),
      { code: status.INVALID_ARGUMENT }
    );
  }
});

export class GetCartDto implements cartProto.GetCartRequest {
  /** Present → guest cart; absent → user cart by JWT sub. */
  @IsOptional()
  @IsUUID()
  cartId?: string | undefined;
}

export class AddItemDto implements cartProto.AddItemRequest {
  @IsOptional()
  @IsUUID()
  cartId?: string | undefined;

  @IsString()
  @IsNotEmpty()
  bookId!: string;

  @IsInt()
  @Min(1)
  amount!: number;
}

export class UpdateItemDto implements cartProto.UpdateItemRequest {
  @IsOptional()
  @IsUUID()
  cartId?: string | undefined;

  @IsString()
  @IsNotEmpty()
  bookId!: string;

  /** Absolute amount — 0 removes the position. */
  @IsInt()
  @Min(0)
  amount!: number;
}

export class RemoveItemDto implements cartProto.RemoveItemRequest {
  @IsOptional()
  @IsUUID()
  cartId?: string | undefined;

  @IsString()
  @IsNotEmpty()
  bookId!: string;
}

export class ClearCartDto implements cartProto.ClearCartRequest {
  @IsOptional()
  @IsUUID()
  cartId?: string | undefined;
}

export class MergeCartDto implements cartProto.MergeCartRequest {
  /** Merge source (uuid); never an owner selector — user-mode RPC. */
  @IsUUID()
  guestCartId!: string;
}
