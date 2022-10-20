import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  UseGuards
} from "@nestjs/common";
import {
  AdminJwtAuthGuard,
  JwtAuthGuard
} from "../auth/auth-guards/jwt-auth-guard";
import { BookService } from "./book.service";
import { BookDto } from "../dto/book-dto";
import { JwtAccessTokenPayloadDto } from "../dto/jwt-access-token-payload-dto";
import { User } from "../decorators/user.decorator";
import { CreateBookDto } from "../dto/create-book-dto";
import { UpdateBookDto } from "../dto/update-book-dto";

@Controller("book")
export class BookController {
  constructor(private readonly bookService: BookService) {}

  @Get()
  async findAll(): Promise<BookDto[]> {
    return this.bookService.findAll();
  }

  @Get("findById")
  async findById(@Body("book_id") bookId: number): Promise<BookDto> {
    return this.bookService.findById(bookId);
  }

  @Get("findByName")
  async findByName(@Body("book_name") bookName: string): Promise<BookDto> {
    return this.bookService.findByName(bookName);
  }

  @UseGuards(JwtAuthGuard)
  @Post("create")
  create(
    @User() user: JwtAccessTokenPayloadDto,
    @Body() bookDto: CreateBookDto
  ): Promise<BookDto> {
    return this.bookService.create(bookDto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch("update")
  update(
    @User() user: JwtAccessTokenPayloadDto,
    @Body() bookDto: UpdateBookDto
  ): Promise<BookDto> {
    return this.bookService.update(bookDto);
  }

  @UseGuards(AdminJwtAuthGuard)
  @Delete("delete")
  delete(@Body("book_id") bookId: number): Promise<void> {
    return this.bookService.delete(bookId);
  }
}
