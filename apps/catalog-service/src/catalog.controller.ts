// gRPC surface for CatalogService. Each protected RPC verifies the raw
// `authorization` metadata token itself (defense in depth — spec §6) via
// JwtVerifier and passes the resulting UserContext (or null → the service
// maps UNAUTHENTICATED) down. Read RPCs are public and skip verification.
//
// Request shape is validated at the boundary (fixes F-C3): every handler
// parameter is typed as a class-validator DTO and piped through
// requestValidationPipe — violations become RpcException INVALID_ARGUMENT
// before the domain service (or any repository access) runs. @Ctx() keeps
// the gRPC call Metadata flowing to `callerFrom`: once a parameter is
// decorated, undecorated parameters no longer receive positional args.

import { Controller } from "@nestjs/common";
import type { Metadata } from "@grpc/grpc-js";
import { Ctx, Payload } from "@nestjs/microservices";
import {
  GRPC_METADATA_KEYS,
  JwtVerifier,
  requestValidationPipe,
  type UserContext
} from "@book-shop/common";
import { catalogProto } from "@book-shop/contracts";
import type {
  CommitStockResponse,
  CreateBookResponse,
  DeleteBookResponse,
  GetBookResponse,
  GetBooksByIdsResponse,
  ListBooksResponse,
  ReleaseStockResponse,
  ReserveStockResponse,
  RestoreBookResponse,
  SearchBooksResponse,
  UpdateBookResponse
} from "@book-shop/contracts/gen/catalog";
import { CatalogService } from "./catalog.service";
import {
  CommitStockDto,
  CreateBookDto,
  DeleteBookDto,
  GetBookDto,
  GetBooksByIdsDto,
  ListBooksDto,
  ReleaseStockDto,
  ReserveStockDto,
  RestoreBookDto,
  SearchBooksDto,
  UpdateBookDto
} from "./dto";

@Controller()
@catalogProto.CatalogServiceControllerMethods()
export class CatalogController
  implements catalogProto.CatalogServiceController
{
  constructor(
    private readonly service: CatalogService,
    private readonly verifier: JwtVerifier
  ) {}

  // ---- public reads ----

  listBooks(
    @Payload(requestValidationPipe) request: ListBooksDto
  ): Promise<ListBooksResponse> {
    return this.service.listBooks(request);
  }

  searchBooks(
    @Payload(requestValidationPipe) request: SearchBooksDto
  ): Promise<SearchBooksResponse> {
    return this.service.searchBooks(request);
  }

  getBook(
    @Payload(requestValidationPipe) request: GetBookDto
  ): Promise<GetBookResponse> {
    return this.service.getBook(request);
  }

  getBooksByIds(
    @Payload(requestValidationPipe) request: GetBooksByIdsDto
  ): Promise<GetBooksByIdsResponse> {
    return this.service.getBooksByIds(request);
  }

  // ---- writes: EMPLOYER|ADMIN (create/update), ADMIN (delete/restore) ----

  async createBook(
    @Payload(requestValidationPipe) request: CreateBookDto,
    @Ctx() metadata?: Metadata
  ): Promise<CreateBookResponse> {
    return this.service.createBook(request, await this.callerFrom(metadata));
  }

  async updateBook(
    @Payload(requestValidationPipe) request: UpdateBookDto,
    @Ctx() metadata?: Metadata
  ): Promise<UpdateBookResponse> {
    return this.service.updateBook(request, await this.callerFrom(metadata));
  }

  async deleteBook(
    @Payload(requestValidationPipe) request: DeleteBookDto,
    @Ctx() metadata?: Metadata
  ): Promise<DeleteBookResponse> {
    return this.service.deleteBook(request, await this.callerFrom(metadata));
  }

  async restoreBook(
    @Payload(requestValidationPipe) request: RestoreBookDto,
    @Ctx() metadata?: Metadata
  ): Promise<RestoreBookResponse> {
    return this.service.restoreBook(request, await this.callerFrom(metadata));
  }

  // ---- stock orchestration: any valid JWT ----

  async reserveStock(
    @Payload(requestValidationPipe) request: ReserveStockDto,
    @Ctx() metadata?: Metadata
  ): Promise<ReserveStockResponse> {
    return this.service.reserveStock(request, await this.callerFrom(metadata));
  }

  async commitStock(
    @Payload(requestValidationPipe) request: CommitStockDto,
    @Ctx() metadata?: Metadata
  ): Promise<CommitStockResponse> {
    return this.service.commitStock(request, await this.callerFrom(metadata));
  }

  async releaseStock(
    @Payload(requestValidationPipe) request: ReleaseStockDto,
    @Ctx() metadata?: Metadata
  ): Promise<ReleaseStockResponse> {
    return this.service.releaseStock(request, await this.callerFrom(metadata));
  }

  /** `authorization` metadata → verified UserContext, or null. */
  private async callerFrom(metadata?: Metadata): Promise<UserContext | null> {
    const raw = metadata?.get(GRPC_METADATA_KEYS.authorization)[0];
    if (raw === undefined) {
      return null;
    }
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    const token = text.startsWith("Bearer ") ? text.slice(7) : text;
    return this.verifier.verify(token);
  }
}
