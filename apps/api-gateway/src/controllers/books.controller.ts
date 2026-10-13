// /books (spec §2): catalog proxy. Reads are public; writes go through the
// spec's role matrix — create/update EMPLOYER|ADMIN, delete/restore ADMIN —
// enforced by AuthGuard+RolesGuard as the first level (catalog re-checks
// the same matrix on the wire request — defense in depth).
//
// GET /books routes to SearchBooks when `query`/`genre` is present,
// ListBooks otherwise.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { UserRole } from "@book-shop/contracts";
import type { CatalogClient } from "../clients";
import { CATALOG_CLIENT } from "../tokens";
import { outgoingMetadata, type AuthedRequest } from "../request-context";
import { AuthGuard, Roles, RolesGuard } from "../guards";
import { presentBook } from "../presenters";
import { BooksQueryDto, CreateBookDto, UpdateBookDto } from "../dto";

const DEFAULT_LIMIT = 20;

@ApiTags("books")
@Controller("books")
export class BooksController {
  constructor(
    @Inject(CATALOG_CLIENT) private readonly catalog: CatalogClient
  ) {}

  @Get()
  async list(@Query() query: BooksQueryDto) {
    const offset = query.offset ?? 0;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const result =
      query.query || query.genre
        ? await this.catalog.searchBooks({
            query: query.query || undefined,
            genre: query.genre || undefined,
            offset,
            limit
          })
        : await this.catalog.listBooks({ offset, limit });
    return { books: result.books.map(presentBook), total: result.total };
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    const { book } = await this.catalog.getBook({ bookId: id });
    if (!book) {
      throw new NotFoundException(`book ${id} not found`);
    }
    return presentBook(book);
  }

  @Post()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.Employer, UserRole.Admin)
  async create(@Body() dto: CreateBookDto, @Req() req: AuthedRequest) {
    const { book } = await this.catalog.createBook(
      dto,
      outgoingMetadata(req, req.auth!.accessToken)
    );
    return presentBook(book!);
  }

  @Patch(":id")
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.Employer, UserRole.Admin)
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateBookDto,
    @Req() req: AuthedRequest
  ) {
    const { book } = await this.catalog.updateBook(
      { ...dto, bookId: id },
      outgoingMetadata(req, req.auth!.accessToken)
    );
    return presentBook(book!);
  }

  @Delete(":id")
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.Admin)
  async delete(@Param("id") id: string, @Req() req: AuthedRequest) {
    await this.catalog.deleteBook(
      { bookId: id },
      outgoingMetadata(req, req.auth!.accessToken)
    );
  }

  @Post(":id/restore")
  @HttpCode(200)
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.Admin)
  async restore(@Param("id") id: string, @Req() req: AuthedRequest) {
    const { book } = await this.catalog.restoreBook(
      { bookId: id },
      outgoingMetadata(req, req.auth!.accessToken)
    );
    return presentBook(book!);
  }
}
