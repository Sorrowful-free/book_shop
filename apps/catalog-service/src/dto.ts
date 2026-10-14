import { Type } from "class-transformer";
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested
} from "class-validator";
import {
  COVER_CONTENT_TYPES,
  COVER_KEY_PATTERN,
  type catalogProto
} from "@book-shop/contracts";
import { MAX_LIMIT } from "./catalog.service";

/**
 * Boundary validation for the gRPC surface (docs/specs/fixes/catalog-service.md
 * F-C3): the static shape of each request — required non-empty strings,
 * pagination bounds, integer sign — is checked by class-validator DTOs via
 * the shared `requestValidationPipe` (@book-shop/common) before the domain
 * service (and thus the repository) is reached; a violation maps to
 * RpcException INVALID_ARGUMENT.
 *
 * Domain rules stay in CatalogService: isbn uniqueness, stock-vs-reserved,
 * the dynamic year upper bound (current year + 1), reservation states, and
 * the DB-column bounds for price/stock/aggregated amounts (F-C2).
 *
 * proto3 implicit presence: non-`optional` scalar fields carrying their
 * default value (0, "") are never serialized on the wire and arrive absent —
 * e.g. `offset: 0`, `price: 0`, `amount: 0`, `book_id: ""`. Required
 * non-empty strings therefore double as "not the proto default", and `offset`
 * is optional in the DTO with the service normalizing it to 0.
 */

export class ListBooksDto implements catalogProto.ListBooksRequest {
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

export class SearchBooksDto implements catalogProto.SearchBooksRequest {
  /** Empty string is allowed — the service treats it as absent. */
  @IsOptional()
  @IsString()
  query?: string | undefined;

  @IsOptional()
  @IsString()
  genre?: string | undefined;

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

export class GetBookDto implements catalogProto.GetBookRequest {
  @IsString()
  @IsNotEmpty()
  bookId!: string;
}

export class GetBooksByIdsDto implements catalogProto.GetBooksByIdsRequest {
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  bookIds!: string[];
}

export class CreateBookDto implements catalogProto.CreateBookRequest {
  @IsString()
  @IsNotEmpty()
  bookName!: string;

  @IsString()
  @IsNotEmpty()
  author!: string;

  @IsOptional()
  @IsString()
  isbn?: string | undefined;

  @IsOptional()
  @IsString()
  description?: string | undefined;

  @IsOptional()
  @IsString()
  genre?: string | undefined;

  /** Non-negative int; the "current year + 1" cap stays in the service. */
  @IsOptional()
  @IsInt()
  @Min(0)
  year?: number | undefined;

  @IsOptional()
  @IsString()
  coverUrl?: string | undefined;

  /** Non-negative here; the Decimal(10,2) upper bound stays in the service. */
  @IsNumber()
  @Min(0)
  price!: number;

  /** Non-negative int here; the int4 upper bound stays in the service. */
  @IsInt()
  @Min(0)
  stock!: number;
}

export class UpdateBookDto implements catalogProto.UpdateBookRequest {
  @IsString()
  @IsNotEmpty()
  bookId!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  bookName?: string | undefined;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  author?: string | undefined;

  @IsOptional()
  @IsString()
  isbn?: string | undefined;

  @IsOptional()
  @IsString()
  description?: string | undefined;

  @IsOptional()
  @IsString()
  genre?: string | undefined;

  /** Non-negative int; the "current year + 1" cap stays in the service. */
  @IsOptional()
  @IsInt()
  @Min(0)
  year?: number | undefined;

  @IsOptional()
  @IsString()
  coverUrl?: string | undefined;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number | undefined;

  @IsOptional()
  @IsInt()
  @Min(0)
  stock?: number | undefined;
}

export class DeleteBookDto implements catalogProto.DeleteBookRequest {
  @IsString()
  @IsNotEmpty()
  bookId!: string;
}

export class RestoreBookDto implements catalogProto.RestoreBookRequest {
  @IsString()
  @IsNotEmpty()
  bookId!: string;
}

export class StockReservationItemDto
  implements catalogProto.StockReservationItem
{
  @IsString()
  @IsNotEmpty()
  bookId!: string;

  @IsInt()
  @Min(1)
  amount!: number;
}

export class ReserveStockDto implements catalogProto.ReserveStockRequest {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => StockReservationItemDto)
  items!: StockReservationItemDto[];
}

export class CommitStockDto implements catalogProto.CommitStockRequest {
  @IsString()
  @IsNotEmpty()
  reservationId!: string;
}

export class ReleaseStockDto implements catalogProto.ReleaseStockRequest {
  @IsString()
  @IsNotEmpty()
  reservationId!: string;
}

export class CreateCoverUploadDto
  implements catalogProto.CreateCoverUploadRequest
{
  /** mime whitelist (spec 08 §3) — the service maps it to the extension. */
  @IsString()
  @IsIn(Object.keys(COVER_CONTENT_TYPES))
  contentType!: string;
}

export class GetBookCoverDto implements catalogProto.GetBookCoverRequest {
  /** `<uuid>.<ext>` only — arbitrary keys never reach the store (spec §3). */
  @IsString()
  @Matches(COVER_KEY_PATTERN)
  key!: string;
}
