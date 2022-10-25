import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/auth-guards/jwt-auth-guard";
import { BookService } from "./book.service";
import { BookDto } from "../dto/book-dto";
import { User } from "../decorators/user-decorator";
import { CreateBookDto } from "../dto/create-book-dto";
import { UpdateBookDto } from "../dto/update-book-dto";
import { UserDto, UserRole } from "../dto/user-dto";
import { UserRoles } from "../decorators/user-role-decorator";
import { UserRolesAuthGuard } from "../auth/auth-guards/user-roles-auth-guard";

@Controller("book")
export class BookController {
  constructor(private readonly bookService: BookService) {}

  @Get()
  async findAll(
    @Body("index") index = 0,
    @Body("count") count = 10
  ): Promise<BookDto[]> {
    return this.bookService.findAll(index, count);
  }

  @Get("findById")
  async findById(@Body("book_id") bookId: any): Promise<BookDto> {
    return this.bookService.findById(bookId);
  }

  @Get("findByName")
  async findByName(@Body("book_name") bookName: string): Promise<BookDto> {
    return this.bookService.findByName(bookName);
  }

  @UserRoles(UserRole.Employer, UserRole.Admin)
  @UseGuards(JwtAuthGuard, UserRolesAuthGuard)
  @Post("create")
  create(
    @User() user: UserDto,
    @Body() bookDto: CreateBookDto
  ): Promise<BookDto> {
    return this.bookService.create(bookDto);
  }

  @UserRoles(UserRole.Employer, UserRole.Admin)
  @UseGuards(JwtAuthGuard, UserRolesAuthGuard)
  @Patch("update")
  update(
    @User() user: UserDto,
    @Body() bookDto: UpdateBookDto
  ): Promise<BookDto> {
    return this.bookService.update(bookDto);
  }

  @UserRoles(UserRole.Admin)
  @UseGuards(JwtAuthGuard, UserRolesAuthGuard)
  @Delete("delete")
  delete(
    @User() user: UserDto,
    @Body("book_id") bookId: number
  ): Promise<void> {
    return this.bookService.delete(bookId);
  }
}
