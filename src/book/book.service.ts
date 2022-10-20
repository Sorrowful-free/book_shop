import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { BookDto } from "../dto/book-dto";
import { CreateBookDto } from "../dto/create-book-dto";
import { UpdateBookDto } from "../dto/update-book-dto";

@Injectable()
export class BookService {
  constructor(private readonly databaseService: DatabaseService) {}

  findAll(): Promise<BookDto[]> {
    return this.databaseService.findAllBooks();
  }

  findById(bookId: number): Promise<BookDto> {
    return this.databaseService.findBookById(bookId);
  }

  findByName(bookName: string): Promise<BookDto> {
    return this.databaseService.findBookByName(bookName);
  }

  create(bookDto: CreateBookDto): Promise<BookDto> {
    return this.databaseService.createBook(bookDto);
  }

  update(bookDto: UpdateBookDto): Promise<BookDto> {
    return this.databaseService.updateBook(bookDto);
  }

  delete(bookId: number): Promise<void> {
    return this.databaseService.deleteBook(bookId);
  }
}
