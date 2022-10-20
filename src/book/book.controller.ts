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
import { User } from "../decorators/user.decorator";
import { CreateBookDto } from "../dto/create-book-dto";
import { UpdateBookDto } from "../dto/update-book-dto";
import { UserDto, UserRole } from "../dto/user-dto";

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
    @User() user: UserDto,
    @Body() bookDto: CreateBookDto
  ): Promise<BookDto> {
    this.checkUserRoles(user, UserRole.Employer, UserRole.Admin);
    return this.bookService.create(bookDto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch("update")
  update(
    @User() user: UserDto,
    @Body() bookDto: UpdateBookDto
  ): Promise<BookDto> {
    this.checkUserRoles(user, UserRole.Employer, UserRole.Admin);
    return this.bookService.update(bookDto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete("delete")
  delete(
    @User() user: UserDto,
    @Body("book_id") bookId: number
  ): Promise<void> {
    this.checkUserRoles(user, UserRole.Admin);
    return this.bookService.delete(bookId);
  }

  private checkUserRoles(user: UserDto, ...userRoles: UserRole[]): void {
    console.log("user: " + JSON.stringify(user));
    for (let i = 0; i < userRoles.length; i++) {
      const userRole = userRoles[i];
      if (user.user_role == userRole) {
        return;
      }
      throw new UnauthorizedException(
        `users with role: #${UserRole[user.user_role]}# dont have permissions`
      );
    }
  }
}
