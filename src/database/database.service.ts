import { Injectable, NotFoundException } from "@nestjs/common";
import { UserDto, UserRole } from "../dto/user-dto";
import { BookDto } from "../dto/book-dto";
import { CreateBookDto } from "../dto/create-book-dto";
import { UpdateBookDto } from "../dto/update-book-dto";

@Injectable()
export class DatabaseService {
  private readonly users: UserDto[] = [
    {
      user_id: 1,
      user_name: "admin",
      password: "admin",
      user_role: UserRole.Admin
    },
    {
      user_id: 2,
      user_name: "vitek",
      password: "super_puper_pass",
      user_role: UserRole.Employer
    },
    {
      user_id: 42,
      user_name: "vasya",
      password: "super_puper_pass",
      user_role: UserRole.Customer
    }
  ];

  private readonly books: BookDto[] = [
    { book_id: 1, book_name: "book number 1", author: "vasya pupkin" },
    { book_id: 2, book_name: "book number 2", author: "vasya pupkin" },
    { book_id: 3, book_name: "book number 3", author: "vasya pupkin" }
  ];

  findUserByUserName(
    userName: string,
    pass: string
  ): Promise<UserDto> | Promise<undefined> {
    const user = this.users.find((e) => e.user_name === userName);
    if (!user || user.password !== pass) {
      throw new NotFoundException(`user with username ${userName} not found`);
    }
    return Promise.resolve(user);
  }

  findUserById(userId: number): Promise<UserDto> | Promise<undefined> {
    const user = this.users.find((e) => e.user_id === userId);
    if (!user) {
      throw new NotFoundException(`user with user id ${userId} not found`);
    }
    return Promise.resolve(user);
  }

  findAllBooks(): Promise<BookDto[]> {
    return Promise.resolve(this.books);
  }

  findBookById(bookId: number): Promise<BookDto> {
    const book = this.books.find((e) => e.book_id === bookId);
    if (!book) {
      throw new NotFoundException(`book with id ${bookId} not found`);
    }
    return Promise.resolve(book);
  }

  findBookByName(bookName: string): Promise<BookDto> {
    const book = this.books.find((e) => e.book_name === bookName);
    if (!book) {
      throw new NotFoundException(`book with name ${bookName} not found`);
    }
    return Promise.resolve(book);
  }

  createBook(createBookDto: CreateBookDto): Promise<BookDto> {
    const book_id = this.books[this.books.length - 1].book_id + 1;
    const bookDto = <BookDto>{
      book_id: book_id,
      book_name: createBookDto.book_name,
      author: createBookDto.author
    };

    this.books.push(bookDto);
    return Promise.resolve(bookDto);
  }

  updateBook(updateBookDto: UpdateBookDto): Promise<BookDto> {
    const bookIndex = this.books.findIndex(
      (e) => e.book_id == updateBookDto.book_id
    );
    if (bookIndex < 0) {
      throw new NotFoundException(
        `book with id ${updateBookDto.book_id} not found`
      );
    }
    const bookDto = this.books[bookIndex];
    const updatedBookDto = <BookDto>{
      book_id: bookDto.book_id,
      book_name: updateBookDto.book_name ?? bookDto.book_name,
      author: updateBookDto.author ?? bookDto.author
    };

    this.books[bookIndex] = updatedBookDto;
    return Promise.resolve(updatedBookDto);
  }

  deleteBook(bookId: number): Promise<void> {
    const bookIndex = this.books.findIndex((e) => e.book_id == bookId);
    if (bookIndex < 0) {
      throw new NotFoundException(`book with id ${bookId} not found`);
    }
    this.books.splice(bookIndex, 1);
    return Promise.resolve();
  }
}
