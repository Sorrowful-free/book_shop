import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { BookDto } from "../dto/book-dto";
import { CreateBookDto } from "../dto/create-book-dto";
import { UpdateBookDto } from "../dto/update-book-dto";

@Injectable()
export class BookService {
  constructor(private readonly databaseService: DatabaseService) {}

  findAll(index = 0, count = 10): Promise<BookDto[]> {
    return this.databaseService.findAllBooks(index, count);
  }

  findById(bookId: any): Promise<BookDto> {
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

  delete(bookId: any): Promise<void> {
    return this.databaseService.deleteBook(bookId);
  }
}
