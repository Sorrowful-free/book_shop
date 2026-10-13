// Boundary validation (spec §10): incoming bodies/query are checked by
// class-validator via the global ValidationPipe BEFORE any upstream call;
// violations → 400 through the error filter. Constraints mirror the
// downstream services' DTOs — the static shape only; domain rules (password
// complexity, isbn uniqueness, stock guards) stay in the services.
//
// Query params arrive as strings — @Type(() => Number) coerces them so the
// int validators see real numbers (ValidationPipe transform: true).

import { Type } from "class-transformer";
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min
} from "class-validator";

/** Mirrors auth-service USER_NAME_PATTERN (kept in sync — same message). */
export const USER_NAME_PATTERN = /^[A-Za-z0-9_]{3,32}$/;
export const USER_NAME_MESSAGE = "user_name must be 3-32 chars of [a-zA-Z0-9_]";

/** Shared page bound — catalog and order services both cap at 100. */
const MAX_LIMIT = 100;

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

export class RegisterDto {
  @Matches(USER_NAME_PATTERN, { message: USER_NAME_MESSAGE })
  userName!: string;

  /** Complexity rules stay in auth-service — non-empty is the static shape. */
  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class LoginDto {
  @Matches(USER_NAME_PATTERN, { message: USER_NAME_MESSAGE })
  userName!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

/** refresh_token may also arrive via cookie — the body field is optional. */
export class RefreshBodyDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  refreshToken?: string;
}

export class LogoutBodyDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  refreshToken?: string;
}

// ---------------------------------------------------------------------------
// books
// ---------------------------------------------------------------------------

export class BooksQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsString()
  genre?: string;
}

export class CreateBookDto {
  @IsString()
  @IsNotEmpty()
  bookName!: string;

  @IsString()
  @IsNotEmpty()
  author!: string;

  @IsOptional()
  @IsString()
  isbn?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  genre?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  year?: number;

  @IsOptional()
  @IsString()
  coverUrl?: string;

  @IsNumber()
  @Min(0)
  price!: number;

  @IsInt()
  @Min(0)
  stock!: number;
}

export class UpdateBookDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  bookName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  author?: string;

  @IsOptional()
  @IsString()
  isbn?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  genre?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  year?: number;

  @IsOptional()
  @IsString()
  coverUrl?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  stock?: number;
}

// ---------------------------------------------------------------------------
// cart
// ---------------------------------------------------------------------------

export class AddCartItemDto {
  @IsString()
  @IsNotEmpty()
  bookId!: string;

  @IsInt()
  @Min(1)
  amount!: number;
}

export class UpdateCartItemDto {
  @IsInt()
  @Min(0)
  amount!: number;
}

// ---------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------

export class OrdersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;
}
