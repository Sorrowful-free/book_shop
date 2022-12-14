import { Injectable, NotFoundException } from "@nestjs/common";
import { UserDto, UserRole } from "../dto/user-dto";
import { BookDto } from "../dto/book-dto";
import { CreateBookDto } from "../dto/create-book-dto";
import { UpdateBookDto } from "../dto/update-book-dto";
import { InjectModel } from "@nestjs/mongoose";
import { Book, BookDocument } from "../mongo-schemas/book";
import { Goods, Order, OrderDocument } from "../mongo-schemas/order";
import { Model } from "mongoose";
import { OrderDto } from "../dto/order-dto";
import { GoodsDto } from "../dto/goods-dto";
import { CreateOrderDto } from "../dto/create-order-dto";

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

  constructor(
    @InjectModel(Book.name) private readonly bookModel: Model<BookDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>
  ) {}

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

  async findAllBooks(index = 0, count = 10): Promise<BookDto[]> {
    const mongoBooks = await this.bookModel.find().exec();
    return mongoBooks
      .slice(index, index + count)
      .map((e) => this.convertBook(e));
  }

  async findBooksByIds(booksIds: any[]): Promise<BookDto[]> {
    const mongoBooks = await this.bookModel
      .find({ _id: { $in: booksIds } })
      .exec();
    if (!mongoBooks && mongoBooks.length > 0) {
      throw new NotFoundException(
        `books with ids ${booksIds.join(", ")} not found`
      );
    }
    return mongoBooks.map((e) => this.convertBook(e));
  }

  async findBookById(bookId: any): Promise<BookDto> {
    const mongoBook = await this.bookModel.findById(bookId).exec();
    if (!mongoBook) {
      throw new NotFoundException(`book with id ${bookId} not found`);
    }
    return this.convertBook(mongoBook);
  }

  async findBookByName(bookName: string): Promise<BookDto> {
    const mongoBook = await this.bookModel
      .findOne({ book_name: bookName })
      .exec();
    if (!mongoBook) {
      throw new NotFoundException(`book with name ${bookName} not found`);
    }
    return this.convertBook(mongoBook);
  }

  async createBook(bookDto: CreateBookDto): Promise<BookDto> {
    const createdBook = new this.bookModel(bookDto);
    return this.convertBook(await createdBook.save());
  }

  async updateBook(bookDto: UpdateBookDto): Promise<BookDto> {
    const mongoBook = await this.bookModel.findOneAndUpdate(bookDto.book_id, {
      $set: {
        book_name: bookDto.book_name,
        author: bookDto.author
      }
    });
    if (!mongoBook) {
      throw new NotFoundException(`book with id ${bookDto.book_id} not found`);
    }
    return {
      book_id: bookDto.book_id,
      book_name: bookDto.book_name ?? mongoBook.book_name,
      author: bookDto.author ?? mongoBook.author,
      price: bookDto.price ?? mongoBook.price
    };
  }

  async deleteBook(bookId: any): Promise<void> {
    const result = await this.bookModel.findByIdAndDelete(bookId);

    if (!result) {
      throw new NotFoundException(`book with id ${bookId} not found`);
    }

    return Promise.resolve();
  }

  async findOrder(orderId: any): Promise<OrderDto> {
    const mongoOrder = await this.orderModel.findById(orderId).exec();
    if (!mongoOrder) {
      throw new NotFoundException(`order with id ${orderId} not found`);
    }
    return this.convertOrder(mongoOrder);
  }

  async createOrder(orderDto: CreateOrderDto): Promise<OrderDto> {
    const createdOrder = new this.orderModel(orderDto);
    return this.convertOrder(await createdOrder.save());
  }

  async deleteOrder(orderId: any): Promise<void> {
    const result = await this.orderModel.findByIdAndDelete(orderId);

    if (!result) {
      throw new NotFoundException(`order with id ${orderId} not found`);
    }

    return Promise.resolve();
  }

  private convertBook(bookDocument: BookDocument): BookDto {
    return {
      book_id: bookDocument._id,
      book_name: bookDocument.book_name,
      author: bookDocument.author,
      price: bookDocument.price
    };
  }

  private convertOrder(orderDocument: OrderDocument): OrderDto {
    return {
      order_id: orderDocument.order_id ?? orderDocument._id,
      goods: orderDocument.goods.map((e) => this.convertGoods(e))
    };
  }

  private convertGoods(goods: Goods): GoodsDto {
    return {
      book_id: goods.book_id,
      description: goods.description,
      price: goods.price,
      amount: goods.amount
    };
  }
}
