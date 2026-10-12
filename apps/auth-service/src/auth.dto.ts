// Boundary DTOs for the gRPC surface (fixes spec F-A4): static shape
// constraints — types, requiredness, the user_name charset, non-empty
// tokens/ids — are validated by class-validator in `requestValidationPipe`
// BEFORE AuthService runs; violations surface as INVALID_ARGUMENT.
// Domain rules (password complexity, DB lookups) stay in the service, so
// the rules here deliberately mirror — not replace — its checks (same
// regex, same message → no drift between the two).

import { status } from "@grpc/grpc-js";
import { ValidationPipe } from "@nestjs/common";
import { RpcException } from "@nestjs/microservices";
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  type ValidationError
} from "class-validator";
import type { authProto } from "@book-shop/contracts";
import { USER_NAME_MESSAGE, USER_NAME_PATTERN } from "./auth.service";

function constraintMessages(errors: ValidationError[]): string[] {
  const messages: string[] = [];
  for (const error of errors) {
    if (error.constraints) {
      messages.push(...Object.values(error.constraints));
    }
    if (error.children?.length) {
      messages.push(...constraintMessages(error.children));
    }
  }
  return messages;
}

/**
 * Shared request pipe: a malformed message dies here with INVALID_ARGUMENT
 * ({code, message} — the same RpcException convention as AuthService's
 * `grpcError`, top-level `code` included) before any domain logic runs.
 */
export const requestValidationPipe = new ValidationPipe({
  transform: true,
  exceptionFactory: (errors: ValidationError[]) =>
    Object.assign(
      new RpcException({
        code: status.INVALID_ARGUMENT,
        message: constraintMessages(errors).join("; ") || "invalid request"
      }),
      { code: status.INVALID_ARGUMENT }
    )
});

export class RegisterDto implements authProto.RegisterRequest {
  @Matches(USER_NAME_PATTERN, { message: USER_NAME_MESSAGE })
  userName!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class LoginDto implements authProto.LoginRequest {
  @Matches(USER_NAME_PATTERN, { message: USER_NAME_MESSAGE })
  userName!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class RefreshDto implements authProto.RefreshRequest {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class RevokeTokenDto implements authProto.RevokeTokenRequest {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;

  /** Optional companion access token — "" means absent (proto3 semantics). */
  @IsOptional()
  @IsString()
  accessToken?: string;
}

export class ValidateTokenDto implements authProto.ValidateTokenRequest {
  @IsString()
  @IsNotEmpty()
  accessToken!: string;
}

export class GetUserDto implements authProto.GetUserRequest {
  @IsString()
  @IsNotEmpty()
  userId!: string;
}
