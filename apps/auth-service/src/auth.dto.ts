// Boundary DTOs for the gRPC surface (fixes spec F-A4): static shape
// constraints — types, requiredness, the user_name charset, non-empty
// tokens/ids — are validated by class-validator in `requestValidationPipe`
// BEFORE AuthService runs; violations surface as INVALID_ARGUMENT.
// Domain rules (password complexity, DB lookups) stay in the service, so
// the rules here deliberately mirror — not replace — its checks (same
// regex, same message → no drift between the two).

import { IsNotEmpty, IsOptional, IsString, Matches } from "class-validator";
import type { authProto } from "@book-shop/contracts";
import { USER_NAME_MESSAGE, USER_NAME_PATTERN } from "./auth.service";

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
